import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL, CHAT_RECENT_MESSAGES_LIMIT, CHAT_MEMORIES_LIMIT } from '@/lib/config';

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
    .limit(CHAT_MEMORIES_LIMIT);
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
    .limit(CHAT_RECENT_MESSAGES_LIMIT);

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
    const orchestratorMessages = [
      { role: 'system', content: header },
      ...ordered.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    ];

    const resp = await fetch(`${ORCHESTRATOR_URL}/v1/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_type: 'chat_primary',
        messages: orchestratorMessages,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('orchestrator chat stream error:', resp.status, text);
      return NextResponse.json({ error: 'Chat failed' }, { status: 502 });
    }

    const stream = resp.body;
    if (!stream) {
      return NextResponse.json({ error: 'No stream' }, { status: 502 });
    }

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Conversation-Id': conversation.id,
      },
    });
  } catch (err) {
    console.error('chat error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    );
  }
}
