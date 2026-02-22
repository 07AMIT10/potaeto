import { createClient } from '@/lib/supabase/server';
import { getGeminiApiKey, getGeminiTtsModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

/** POST: { text: string } -> returns audio bytes (e.g. MP3 or raw). */
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { text } = body as { text: string };
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
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
            },
          },
        }),
      }
    );
    if (!response.ok) {
      const err = await response.text();
      console.error('TTS API error:', err);
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
    console.error('tts error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TTS failed' },
      { status: 500 }
    );
  }
}
