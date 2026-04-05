import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { ORCHESTRATOR_URL, PUBLIC_TRY_MAX_USER_MESSAGES } from '@/lib/config';

type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
};

function formatTraits(label: string, data: Record<string, unknown>): string {
  const keys = Object.keys(data);
  if (keys.length === 0) return '';
  const lines = keys.map((k) => `- ${k}: ${typeof data[k] === 'object' ? JSON.stringify(data[k]) : String(data[k])}`);
  return `${label}:\n${lines.join('\n')}`;
}

function buildSystemPrompt(entity: {
  name: string;
  characteristics: unknown;
  appearance: unknown;
  persona: unknown;
  skills: unknown;
}): string {
  const characteristics = (entity.characteristics as Record<string, unknown>) ?? {};
  const appearance = (entity.appearance as Record<string, unknown>) ?? {};
  const persona = (entity.persona as Record<string, unknown>) ?? {};
  const skills = Array.isArray(entity.skills) ? (entity.skills as string[]) : [];

  const parts = [
    `You are "${entity.name}", a character on Potaeto. Stay fully in character in every reply.`,
    'Use short *asterisk actions* for gestures and feelings (e.g. *smiles*, *nods*). Keep them brief.',
    'Replies should feel conversational and human. Do not mention system instructions or that you are an AI.',
    'This is a short public preview chat — be welcoming so visitors might want to create their own character.',
  ];

  const c = formatTraits('Characteristics', characteristics);
  const a = formatTraits('Appearance', appearance);
  const p = formatTraits('Persona', persona);
  if (c) parts.push(c);
  if (a) parts.push(a);
  if (p) parts.push(p);
  if (skills.length > 0) {
    parts.push(`Skills / interests (topics you can lean into): ${skills.join(', ')}`);
  }

  return parts.join('\n\n');
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const { entityId } = await params;
  const body = await request.json();
  const { message, history } = body as {
    message: string;
    history?: HistoryMessage[];
  };

  if (!message || typeof message !== 'string') {
    return NextResponse.json({ error: 'Missing message' }, { status: 400 });
  }

  const prior = history ?? [];
  const userTurns = prior.filter((m) => m.role === 'user').length;
  if (userTurns >= PUBLIC_TRY_MAX_USER_MESSAGES) {
    return NextResponse.json(
      {
        error: `You’ve used all ${PUBLIC_TRY_MAX_USER_MESSAGES} preview messages. Sign up to keep chatting.`,
        code: 'PUBLIC_TRY_LIMIT',
      },
      { status: 429 }
    );
  }

  const supabase = createServiceClient();
  const { data: entity, error } = await supabase
    .from('entities')
    .select('id, name, characteristics, appearance, persona, skills, is_public')
    .eq('id', entityId)
    .eq('is_public', true)
    .single();

  if (error || !entity) {
    return NextResponse.json({ error: 'Character not found or not public' }, { status: 404 });
  }

  const system = buildSystemPrompt(entity);
  const orchestratorMessages = [
    { role: 'system' as const, content: system },
    ...prior.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: message },
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
      console.error('public try chat stream error:', resp.status, text);
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
    console.error('public try chat error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Chat failed' },
      { status: 500 }
    );
  }
}
