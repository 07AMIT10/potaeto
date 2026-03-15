import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/auth/resolveUserId';

export async function POST(request: Request) {
  const { userId, supabase } = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { entityId, prompt, save } = body as { entityId?: string; prompt: string; save?: boolean };
  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  let systemInstruction = '';
  if (entityId) {
    const { data: entity } = await supabase
      .from('entities')
      .select('name, characteristics, persona, skills')
      .eq('id', entityId)
      .eq('user_id', userId)
      .single();
    if (entity) {
      systemInstruction = `You are writing as or for the character "${entity.name}". Stay in character. Characteristics: ${JSON.stringify(entity.characteristics)}. Persona: ${JSON.stringify(entity.persona)}. Skills: ${JSON.stringify(entity.skills)}.`;
    }
  }

  try {
    const ai = createGeminiClient(apiKey);
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      config: systemInstruction ? { systemInstruction } : undefined,
      contents: prompt,
    });
    type GenResult = { text?: string };
    const text = (res as GenResult).text ?? '';

    if (save && entityId) {
      await supabase.from('content').insert({
        user_id: userId,
        entity_id: entityId,
        type: 'text',
        storage_path: null,
        public_url: null,
        metadata: { prompt, text },
      });
    }

    return NextResponse.json({ text });
  } catch (err) {
    console.error('text gen error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Text generation failed' },
      { status: 500 }
    );
  }
}
