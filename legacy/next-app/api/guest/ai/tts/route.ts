import { NextResponse } from 'next/server';
import { getGeminiApiKey, getGeminiTtsModel } from '@/lib/gemini';
import { GEMINI_TTS_VOICE } from '@/lib/config';

export async function POST(request: Request) {
  const body = await request.json();
  const { text } = body as { text?: string };
  if (!text || typeof text !== 'string') {
    return NextResponse.json({ error: 'Missing text' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${getGeminiTtsModel()}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } },
            },
          },
        }),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.error('guest TTS API error:', err);
      return NextResponse.json({ error: 'TTS failed' }, { status: 502 });
    }
    const data = await response.json();
    const audioBytes = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioBytes) {
      return NextResponse.json({ error: 'No audio in response' }, { status: 502 });
    }
    const buffer = Buffer.from(audioBytes, 'base64');
    return new NextResponse(buffer, {
      headers: { 'Content-Type': 'audio/mp3' },
    });
  } catch (err) {
    console.error('guest tts error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TTS failed' },
      { status: 500 }
    );
  }
}

