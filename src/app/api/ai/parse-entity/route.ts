import { NextResponse } from 'next/server';
import { ORCHESTRATOR_URL } from '@/lib/config';
import { resolveUserId } from '@/lib/auth/resolveUserId';
import { ensureUniqueEntitySlug } from '@/lib/entities/slug';

export async function POST(request: Request) {
  const { userId, supabase } = await resolveUserId();
  if (!userId) {
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
      let errMsg = 'Failed to parse entity';
      try {
        const errBody = JSON.parse(msg) as { detail?: string };
        if (typeof errBody.detail === 'string') errMsg = errBody.detail;
      } catch {
        // use default
      }
      return NextResponse.json({ error: errMsg }, { status: res.status === 422 ? 422 : 502 });
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

    const slug = await ensureUniqueEntitySlug(supabase, userId, entity.slug || 'entity');
    const { data: inserted, error } = await supabase
      .from('entities')
      .insert({
        user_id: userId,
        name: entity.name,
        slug,
        characteristics: entity.characteristics ?? {},
        appearance: entity.appearance ?? {},
        persona: entity.persona ?? {},
        skills: entity.skills ?? [],
        attributes: entity.attributes ?? {},
      })
      .select('id, name, slug')
      .single();

    if (error) {
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
