import { NextResponse } from 'next/server';
import { maybeUpdateSummary } from '@/lib/chat-memory';
import { ORCHESTRATOR_URL } from '@/lib/config';
import { resolveUserId } from '@/lib/auth/resolveUserId';

/**
 * Called by the client after a streaming chat response is complete.
 * Persists the assistant message and optionally runs summary/memory update.
 */
export async function POST(request: Request) {
  const { userId, supabase } = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { entityId, conversationId, content } = body as {
    entityId: string;
    conversationId: string;
    content: string;
  };

  if (!entityId || !conversationId || typeof content !== 'string') {
    return NextResponse.json(
      { error: 'Missing entityId, conversationId, or content' },
      { status: 400 }
    );
  }

  const { data: conv, error: convError } = await supabase
    .from('conversations')
    .select('id, user_id, entity_id')
    .eq('id', conversationId)
    .eq('user_id', userId)
    .eq('entity_id', entityId)
    .single();

  if (convError || !conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return NextResponse.json({ ok: true });
  }

  const { error: insertError } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    user_id: userId,
    role: 'assistant',
    content: trimmed,
  });

  if (insertError) {
    console.error('finalize insert message error:', insertError);
    return NextResponse.json({ error: 'Failed to save message' }, { status: 500 });
  }

  await maybeUpdateSummary({
    supabase,
    conversationId,
    userId: userId,
    entityId,
    orchestratorUrl: ORCHESTRATOR_URL,
  });

  return NextResponse.json({ ok: true });
}
