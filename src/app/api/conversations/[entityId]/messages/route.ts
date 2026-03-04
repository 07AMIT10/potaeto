import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { CONVERSATION_HISTORY_LIMIT } from '@/lib/config';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const { entityId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: conversation, error: conversationError } = await supabase
    .from('conversations')
    .upsert({ user_id: user.id, entity_id: entityId }, { onConflict: 'user_id,entity_id' })
    .select('id')
    .single();

  if (conversationError || !conversation) {
    console.error('conversation history error:', conversationError);
    return NextResponse.json({ error: 'Failed to load conversation' }, { status: 500 });
  }

  const { data: messages, error: messagesError } = await supabase
    .from('messages')
    .select('id, role, content, meta, created_at')
    .eq('conversation_id', conversation.id)
    .eq('user_id', user.id)
    .in('role', ['user', 'assistant'])
    .order('created_at', { ascending: true })
    .limit(CONVERSATION_HISTORY_LIMIT);

  if (messagesError) {
    console.error('messages history error:', messagesError);
    return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 });
  }

  return NextResponse.json({
    conversationId: conversation.id,
    messages: messages ?? [],
  });
}

