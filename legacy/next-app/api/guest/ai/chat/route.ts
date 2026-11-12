import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL } from '@/lib/config';

type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export async function POST(request: Request) {
  const body = await request.json();
  const { entityName, message, history } = body as {
    entityName: string;
    message: string;
    history?: HistoryMessage[];
  };

  if (!entityName || !message) {
    return NextResponse.json({ error: 'Missing entityName or message' }, { status: 400 });
  }

  const system = [
    `You are "${entityName}", a character/persona. Stay in character in your replies.`,
    'Use a friendly, conversational tone. Keep responses concise and helpful.',
  ].join('\n');

  const prior = (history ?? []).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const orchestratorMessages = [
    { role: 'system', content: system },
    ...prior,
    { role: 'user', content: message },
  ];

  try {
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
      console.error('guest chat stream error:', resp.status, text);
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
      },
    });
  } catch (err) {
    console.error('guest chat error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    );
  }
}

