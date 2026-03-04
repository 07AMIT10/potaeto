/**
 * Shared chat memory helpers: conversation summary and fact extraction.
 * Used by api/ai/chat and api/ai/chat/finalize.
 */

const SUMMARY_TRIGGER_EVERY = 10;
const SUMMARY_MAX_CHARS = 1200;
const SUMMARY_SOURCE_MESSAGES = 20;

type SupabaseClient = Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>;

export async function maybeUpdateSummary(params: {
  supabase: SupabaseClient;
  conversationId: string;
  userId: string;
  entityId: string;
  orchestratorUrl: string;
}) {
  const { supabase, conversationId, userId, entityId, orchestratorUrl } = params;

  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .in('role', ['user', 'assistant']);

  if (!count || count < SUMMARY_TRIGGER_EVERY || count % SUMMARY_TRIGGER_EVERY !== 0) return;

  const { data: existingSummaryRow } = await supabase
    .from('conversation_summaries')
    .select('summary')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .single();

  const { data: recent } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(SUMMARY_SOURCE_MESSAGES);

  const ordered = [...(recent ?? [])].reverse();
  const transcript = ordered
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n');

  try {
    const response = await fetch(`${orchestratorUrl}/v1/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        existing_summary: existingSummaryRow?.summary ?? '',
        transcript,
      }),
    });

    if (!response.ok) {
      console.error('orchestrator summarize error:', response.status, await response.text());
      return;
    }

    const parsed = (await response.json()) as { summary?: string; facts?: string[] };

    const summary = (parsed.summary ?? '').trim().slice(0, SUMMARY_MAX_CHARS);
    if (summary) {
      await supabase.from('conversation_summaries').upsert(
        {
          conversation_id: conversationId,
          user_id: userId,
          entity_id: entityId,
          summary,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'conversation_id' }
      );
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    const factRows = facts
      .map((f) => (typeof f === 'string' ? f.trim() : ''))
      .filter((f) => f.length > 0)
      .map((f) => ({
        user_id: userId,
        entity_id: entityId,
        kind: 'fact' as const,
        content: f,
        weight: 1.0,
      }));

    if (factRows.length > 0) {
      const { error: memoriesError } = await supabase.from('memories').insert(factRows);
      if (memoriesError) {
        console.error('memories insert error:', memoriesError);
      }
    }
  } catch (e) {
    console.error('summary update failed:', e);
  }
}
