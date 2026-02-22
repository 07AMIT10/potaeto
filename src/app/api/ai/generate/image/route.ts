import { createClient } from '@/lib/supabase/server';
import { createGeminiClient, getGeminiApiKey, getGeminiImageModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { entityId, prompt } = body as { entityId?: string; prompt: string };
  if (!prompt || typeof prompt !== 'string') {
    return NextResponse.json({ error: 'Missing prompt' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) return NextResponse.json({ error: 'Gemini API not configured' }, { status: 503 });

  let fullPrompt = prompt;
  if (entityId) {
    const { data: entity } = await supabase
      .from('entities')
      .select('name, appearance')
      .eq('id', entityId)
      .eq('user_id', user.id)
      .single();
    if (entity) {
      const appearance = (entity.appearance as { description?: string })?.description ?? '';
      fullPrompt = appearance ? `${appearance}. ${prompt}` : prompt;
    }
  }

  try {
    const ai = createGeminiClient(apiKey);
    const res = await ai.models.generateImages({
      model: getGeminiImageModel(),
      prompt: fullPrompt,
      config: { numberOfImages: 1 },
    });

    const imagePart = (res as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data: string; mimeType?: string } }> } }>)
      .candidates?.[0]?.content?.parts?.[0];
    const base64 = imagePart?.inlineData?.data;
    const mimeType = imagePart?.inlineData?.mimeType ?? 'image/png';
    if (!base64) {
      return NextResponse.json({ error: 'No image in response' }, { status: 502 });
    }

    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    const path = `${user.id}/${Date.now()}.${ext}`;
    const { data: upload, error: uploadError } = await supabase.storage
      .from('content')
      .upload(path, buffer, { contentType: mimeType, upsert: false });

    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from('content').getPublicUrl(upload.path);
    const publicUrl = urlData.publicUrl;

    const { data: contentRow, error: insertError } = await supabase
      .from('content')
      .insert({
        user_id: user.id,
        entity_id: entityId ?? null,
        type: 'image',
        storage_path: upload.path,
        public_url: publicUrl,
        metadata: { prompt: fullPrompt },
      })
      .select('id, public_url')
      .single();

    if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 });
    return NextResponse.json({ id: contentRow.id, public_url: contentRow.public_url });
  } catch (err) {
    console.error('image gen error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Image generation failed' },
      { status: 500 }
    );
  }
}
