import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL } from '@/lib/config';

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

  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/v1/parse-entity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const msg = await res.text().catch(() => '');
      console.error('orchestrator parse-entity error:', res.status, msg);
      return NextResponse.json({ error: 'Failed to parse entity' }, { status: 502 });
    }

    const entity = (await res.json()) as {
      name: string;
      slug: string;
      characteristics?: Record<string, unknown>;
      appearance?: Record<string, unknown>;
      persona?: Record<string, unknown>;
      skills?: string[];
      attributes?: Record<string, unknown>;
    };

    if (!entity.name || !entity.slug) {
      return NextResponse.json({ error: 'Invalid entity structure from orchestrator' }, { status: 500 });
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
