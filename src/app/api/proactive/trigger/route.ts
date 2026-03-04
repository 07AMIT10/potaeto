import { createServiceClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL, PROACTIVE_IDLE_HOURS, PROACTIVE_MAX_PER_RUN, PROACTIVE_FACTS_LIMIT } from '@/lib/config';

/**
 * POST /api/proactive/trigger
 * 
 * Finds conversations idle for IDLE_HOURS+ and generates a proactive message
 * from the entity. Protected by ADMIN_SECRET or a cron secret.
 * 
 * Can be called by:
 * - Supabase pg_cron + Edge Function
 * - Cloudflare Cron Worker  
 * - Manual admin trigger
 */
export async function POST(request: Request) {
  const secret = request.headers.get('x-admin-secret') || request.headers.get('authorization')?.replace('Bearer ', '');
  const expected = process.env.ADMIN_SECRET;
  if (expected && secret !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const cutoff = new Date(Date.now() - PROACTIVE_IDLE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: idleConversations, error: convError } = await supabase
    .from('conversations')
    .select('id, user_id, entity_id, updated_at')
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .limit(PROACTIVE_MAX_PER_RUN);

  if (convError) {
    console.error('proactive trigger: conversation query error', convError);
    return NextResponse.json({ error: 'Query failed' }, { status: 500 });
  }

  if (!idleConversations || idleConversations.length === 0) {
    return NextResponse.json({ triggered: 0, message: 'No idle conversations found' });
  }

  const { data: recentProactive } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('role', 'assistant')
    .contains('meta', { proactive: true })
    .gt('created_at', cutoff);

  const recentSet = new Set((recentProactive ?? []).map((r) => r.conversation_id));
  const eligible = idleConversations.filter((c) => !recentSet.has(c.id));

  let triggered = 0;
  const errors: string[] = [];

  for (const conv of eligible.slice(0, PROACTIVE_MAX_PER_RUN)) {
    try {
      const { data: entity } = await supabase
        .from('entities')
        .select('name, persona')
        .eq('id', conv.entity_id)
        .single();

      if (!entity) continue;

      const { data: summaryRow } = await supabase
        .from('conversation_summaries')
        .select('summary')
        .eq('conversation_id', conv.id)
        .single();

      const { data: facts } = await supabase
        .from('memories')
        .select('content')
        .eq('user_id', conv.user_id)
        .eq('entity_id', conv.entity_id)
        .in('kind', ['fact', 'preference'])
        .order('created_at', { ascending: false })
        .limit(PROACTIVE_FACTS_LIMIT);

      const res = await fetch(`${ORCHESTRATOR_URL}/v1/proactive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_name: entity.name,
          persona: entity.persona ?? null,
          summary: summaryRow?.summary ?? null,
          recent_facts: (facts ?? []).map((f) => f.content),
        }),
      });

      if (!res.ok) {
        errors.push(`conv ${conv.id}: orchestrator ${res.status}`);
        continue;
      }

      const data = await res.json();
      const msg = (data.message ?? '').trim();
      if (!msg) continue;

      const { error: insertError } = await supabase.from('messages').insert({
        conversation_id: conv.id,
        user_id: conv.user_id,
        role: 'assistant',
        content: msg,
        meta: { proactive: true },
      });

      if (insertError) {
        errors.push(`conv ${conv.id}: insert error ${insertError.message}`);
        continue;
      }

      await supabase
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conv.id);

      triggered++;
    } catch (err) {
      errors.push(`conv ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return NextResponse.json({
    triggered,
    checked: eligible.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
