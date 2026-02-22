import { createClient } from '@/lib/supabase/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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
      .eq('user_id', user.id)
      .single();
    if (entity) {
      systemInstruction = `You are writing as or for the character "${entity.name}". Stay in character. Characteristics: ${JSON.stringify(entity.characteristics)}. Persona: ${JSON.stringify(entity.persona)}. Skills: ${JSON.stringify(entity.skills)}.`;
    }
  }

  try {
    const ai = createGeminiClient(apiKey);
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      systemInstruction: systemInstruction || undefined,
      contents: prompt,
    });
    const text =
      (res as { text?: string }).text ??
      (res as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>).candidates?.[0]?.content?.parts?.[0]?.text ??
      '';

    if (save && entityId) {
      await supabase.from('content').insert({
        user_id: user.id,
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
