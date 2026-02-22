import { createClient } from '@/lib/supabase/server';
import { createGeminiClient, getGeminiApiKey, getGeminiModel } from '@/lib/gemini';
import { NextResponse } from 'next/server';

const ENTITY_JSON_SCHEMA = `
Return a single JSON object (no markdown, no code fence) with exactly these keys:
- name: string (short name for the character/persona)
- slug: string (lowercase, hyphenated, e.g. "chef-mario")
- characteristics: object with optional keys age, role, background (strings)
- appearance: object with optional key description (string), reference_image_urls (array of strings if any)
- persona: object with optional keys tone, style, catchphrases (array), dialogue_examples (array of strings)
- skills: array of strings (e.g. ["cooking", "storytelling"])
- attributes: object with optional key-value pairs (e.g. humor: 0.8, formal: 0.2)
`;

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { text } = body as { text: string };
  if (!text || typeof text !== 'string') {
    return NextResponse.json({ error: 'Missing or invalid text' }, { status: 400 });
  }

  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          'Gemini API key not configured. In .env.local (project root) set GOOGLE_GEMINI_API_KEY=your-key. Then restart the dev server: stop it (Ctrl+C) and run npm run dev again.',
      },
      { status: 503 }
    );
  }

  const ai = createGeminiClient(apiKey);
  const prompt = `The user is describing a character or persona they want to create ("WHO and WHAT"). Extract structured data from their description.

User description:
"""
${text}
"""

${ENTITY_JSON_SCHEMA}`;

  try {
    const res = await ai.models.generateContent({
      model: getGeminiModel(),
      contents: prompt,
    });

    const rawText =
      (res as { text?: string }).text ??
      (res as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0]?.content?.parts?.[0]?.text ??
      '';
    const cleaned = rawText.replace(/^```\w*\n?|\n?```$/g, '').trim();
    const entity = JSON.parse(cleaned) as {
      name: string;
      slug: string;
      characteristics?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      persona?: Record<string, unknown>;
      skills?: string[];
      attributes?: Record<string, unknown>;
    };

    if (!entity.name || !entity.slug) {
      return NextResponse.json({ error: 'Invalid entity structure from AI' }, { status: 500 });
    }

    const { data: profile } = await supabase.from('profiles').select('id').eq('id', user.id).single();
    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 500 });
    }

    const slug = entity.slug.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const { data: inserted, error } = await supabase
      .from('entities')
      .insert({
        user_id: user.id,
        name: entity.name,
        slug: slug || 'entity',
        characteristics: entity.characteristics ?? {},
        appearance: entity.appearance ?? {},
        persona: entity.persona ?? {},
        skills: entity.skills ?? [],
        attributes: entity.attributes ?? {},
      })
      .select('id, name, slug')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'You already have an entity with this slug. Try a different description.' },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(inserted);
  } catch (err) {
    console.error('parse-entity error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to parse entity' },
      { status: 500 }
    );
  }
}
