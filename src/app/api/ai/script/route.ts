import { createClient } from '@/lib/supabase/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

function buildEntityContext(entity: {
  name: string;
  characteristics?: unknown;
  persona?: unknown;
  skills?: unknown;
}) {
  return [
    `Character: ${entity.name}`,
    `Characteristics: ${JSON.stringify(entity.characteristics ?? {})}`,
    `Persona: ${JSON.stringify(entity.persona ?? {})}`,
    `Skills: ${JSON.stringify(entity.skills ?? [])}`,
  ].join('\n');
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { entityId, topic } = body as { entityId: string; topic?: string };

  if (!entityId) return NextResponse.json({ error: 'Missing entityId' }, { status: 400 });

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
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  const ai = createGeminiClient(apiKey);
  const context = buildEntityContext(entity);
  const prompt = topic
    ? `Write a short script (2-4 paragraphs) that ${entity.name} would say about: "${topic}". Stay in character. Output only the script text, no stage directions.`
    : `Write a short script (2-4 paragraphs) that ${entity.name} would say, introducing themselves or telling a brief story. Stay in character. Output only the script text.`;

  try {
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: `${context}\n\n${prompt}`,
    });
    const rawText =
      (res as { text?: string }).text ??
      (res as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>).candidates?.[0]?.content?.parts?.[0]?.text ??
      '';
    return NextResponse.json({ script: rawText.trim() });
  } catch (err) {
    console.error('script error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Script generation failed' },
      { status: 500 }
    );
  }
}
