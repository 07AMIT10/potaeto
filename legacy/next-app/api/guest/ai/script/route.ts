import { NextResponse } from 'next/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';

function buildEntityContext(entityName: string) {
  return `Character: ${entityName}`;
}

export async function POST(request: Request) {
  const body = await request.json();
  const { entityName, topic } = body as { entityName?: string; topic?: string };

  if (!entityName) {
    return NextResponse.json({ error: 'Missing entityName' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  const ai = createGeminiClient(apiKey);
  const context = buildEntityContext(entityName);
  const prompt = topic
    ? `Write a short script (2-4 paragraphs) that ${entityName} would say about: "${topic}". Stay in character. Output only the script text, no stage directions.`
    : `Write a short script (2-4 paragraphs) that ${entityName} would say, introducing themselves or telling a brief story. Stay in character. Output only the script text.`;

  try {
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: `${context}\n\n${prompt}`,
    });
    type GenResult = { text?: string };
    const rawText = (res as GenResult).text ?? '';
    return NextResponse.json({ script: rawText.trim() });
  } catch (err) {
    console.error('guest script error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Script generation failed' },
      { status: 500 }
    );
  }
}

