import { NextResponse } from 'next/server';
import { createGeminiClient, getGeminiApiKey, getGeminiImageModel } from '@/lib/gemini';

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
    const res = await ai.models.generateImages({
      model: getGeminiImageModel(),
      prompt,
      config: { numberOfImages: 1 },
    });

    type GenImageResult = {
      generatedImages?: { image?: { imageBytes?: string; encoding?: string } }[];
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    };
    const typed = res as GenImageResult;
    const generatedImage = typed?.generatedImages?.[0];
    const base64 = generatedImage?.image?.imageBytes
      ?? typed?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    const mimeType = generatedImage?.image?.encoding
      ?? typed?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.mimeType
      ?? 'image/png';

    if (!base64) {
      return NextResponse.json({ error: 'No image in response' }, { status: 502 });
    }

    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;

    return NextResponse.json({ dataUrl, mimeType, ext });
  } catch (err) {
    console.error('guest image gen error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 }
    );
  }
}

