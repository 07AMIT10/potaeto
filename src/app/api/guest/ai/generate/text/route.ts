import { NextResponse } from 'next/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';

export async function POST(request: Request) {
  const body = await request.json();
  const { prompt } = body as { prompt?: string };

  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  try {
    const ai = createGeminiClient(apiKey);
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: prompt,
    });
    type GenResult = { text?: string };
    const text = (res as GenResult).text ?? '';
    return NextResponse.json({ text });
  } catch (err) {
    console.error('guest text gen error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Text generation failed' },
      { status: 500 }
    );
  }
}

