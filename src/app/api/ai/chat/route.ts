import { createClient } from '@/lib/supabase/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

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
  const { entityId, message, history } = body as {
    entityId: string;
    message: string;
    history?: Array<{ role: 'user' | 'model'; parts: string }>;
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

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });
  }

  const ai = createGeminiClient(apiKey);
  const systemPrompt = buildSystemPrompt(entity);

  const contents: Array<{ role: 'user' | 'model'; parts: string }> = [
    ...(history ?? []),
    { role: 'user', parts: message },
  ];

  try {
    const result = await ai.models.generateContentStream({
      model: getGeminiModel(),
      systemInstruction: systemPrompt,
      contents: contents.map((c) => ({ role: c.role, parts: [{ text: c.parts }] })),
    });

    const stream = (result as { stream?: AsyncGenerator<unknown> }).stream ?? result;
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const part = (chunk as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
              .candidates?.[0]?.content?.parts?.[0];
            const text = part?.text ?? (chunk as { text?: string }).text ?? '';
            if (text) controller.enqueue(encoder.encode(text));
          }
        } finally {
          controller.close();
        }
      },
    });

    return new Response(readable, {
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
