import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

const RECENT_MESSAGES_LIMIT = 10;
const SUMMARY_TRIGGER_EVERY = 10;
const SUMMARY_MAX_CHARS = 1200;
const SUMMARY_SOURCE_MESSAGES = 20;
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:8000';

async function maybeUpdateSummary(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  conversationId: string;
  userId: string;
  entityId: string;
}) {
  const { supabase, conversationId, userId, entityId } = params;

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
    const response = await fetch(`${ORCHESTRATOR_URL}/v1/summarize`, {
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

function buildSystemPrompt(entity: {
  name: string;
  characteristics?: unknown;
  appearance?: unknown;
  persona?: unknown;
  skills?: unknown;
}) {
  const parts = [
    `You are "${entity.name}", a character/persona. Stay in character in your replies.`,
    `Characteristics: ${JSON.stringify(entity.characteristics ?? {})}`,
    `Appearance: ${JSON.stringify(entity.appearance ?? {})}`,
    `Persona: ${JSON.stringify(entity.persona ?? {})}`,
    `Skills: ${JSON.stringify(entity.skills ?? [])}`,
  ];
  return parts.join('\n');
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { entityId, message } = body as {
    entityId: string;
    message: string;
  };

  if (!entityId || !message) {
    return NextResponse.json({ error: 'Missing entityId or message' }, { status: 400 });
  }

  const { data: entity, error: entityError } = await supabase
    .from('entities')
    .select('*')
    .eq('id', entityId)
    .eq('user_id', user.id)
    .single();

  if (entityError || !entity) {
    return NextResponse.json({ error: 'Entity not found' }, { status: 404 });
  }

  // Ensure a conversation row exists for this user + entity
  const { data: conversation, error: conversationError } = await supabase
    .from('conversations')
    .upsert(
      { user_id: user.id, entity_id: entityId },
      { onConflict: 'user_id,entity_id' }
    )
    .select('id')
    .single();

  if (conversationError || !conversation) {
    console.error('conversation error:', conversationError);
    return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
  }

  // Store the user message for future memory use
  const { error: insertUserMsgError } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    user_id: user.id,
    role: 'user',
    content: message,
  });
  if (insertUserMsgError) {
    console.error('insert user message error:', insertUserMsgError);
    return NextResponse.json({ error: 'Failed to store message' }, { status: 500 });
  }

  const systemPrompt = buildSystemPrompt(entity);

  const { data: summaryRow, error: summaryError } = await supabase
    .from('conversation_summaries')
    .select('summary')
    .eq('conversation_id', conversation.id)
    .eq('user_id', user.id)
    .single();
  if (summaryError && summaryError.code !== 'PGRST116') {
    console.error('summary fetch error:', summaryError);
  }

  const { data: memoriesRows, error: memoriesError } = await supabase
    .from('memories')
    .select('kind, content')
    .eq('user_id', user.id)
    .eq('entity_id', entityId)
    .in('kind', ['fact', 'preference'])
    .order('created_at', { ascending: false })
    .limit(5);
  if (memoriesError) {
    console.error('memories fetch error:', memoriesError);
  }

  const { data: recentMessages, error: recentMessagesError } = await supabase
    .from('messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversation.id)
    .eq('user_id', user.id)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: false })
    .limit(RECENT_MESSAGES_LIMIT);

  if (recentMessagesError) {
    console.error('recent messages error:', recentMessagesError);
    return NextResponse.json({ error: 'Failed to load conversation context' }, { status: 500 });
  }

  const ordered = [...(recentMessages ?? [])].reverse();

  const memoriesText =
    memoriesRows && memoriesRows.length
      ? memoriesRows
          .map((m) => `- [${m.kind}] ${m.content}`)
          .join('\n')
      : '';

  const headerParts = [
    `SYSTEM:\n${systemPrompt}`,
    summaryRow?.summary ? `\n\nSUMMARY_SO_FAR:\n${summaryRow.summary}` : '',
    memoriesText ? `\n\nMEMORIES:\n${memoriesText}` : '',
    `\n\nINSTRUCTIONS:\nStay in character. Use SUMMARY_SO_FAR, MEMORIES, and prior messages when relevant. Keep responses concise and helpful.`,
  ];
  const header = headerParts.join('');

  try {
    // Build messages for orchestrator /v1/chat
    const orchestratorMessages = [
      {
        role: 'system',
        content: header,
      },
      ...ordered.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    ];

    const resp = await fetch(`${ORCHESTRATOR_URL}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: 'chat_primary',
        messages: orchestratorMessages,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('orchestrator chat error:', resp.status, text);
      return NextResponse.json({ error: 'Chat failed' }, { status: 502 });
    }

    const data = (await resp.json()) as { content?: string };
    const assistantText = (data.content ?? '').trim();

    if (assistantText) {
      const { error: insertAssistantMsgError } = await supabase.from('messages').insert({
        conversation_id: conversation.id,
        user_id: user.id,
        role: 'assistant',
        content: assistantText,
      });
      if (insertAssistantMsgError) {
        console.error('insert assistant message error:', insertAssistantMsgError);
      }

      await maybeUpdateSummary({
        supabase,
        conversationId: conversation.id,
        userId: user.id,
        entityId,
      });
    }

    return new Response(assistantText, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    console.error('chat error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    );
  }
}
