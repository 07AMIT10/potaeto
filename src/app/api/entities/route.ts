import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/auth/resolveUserId';
import { ensureUniqueEntitySlug } from '@/lib/entities/slug';

export async function POST(request: Request) {
  const { userId, supabase } = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, slug, characteristics, appearance, persona, skills, avatar_template } = body;
  const safeSlug = await ensureUniqueEntitySlug(supabase, userId, slug || 'entity');
  const template = avatar_template === 'cat' ? 'cat' : 'potato';

  const { data, error } = await supabase
    .from('entities')
    .insert({
      user_id: userId,
      name: name || 'Unnamed',
      slug: safeSlug,
      characteristics: characteristics ?? {},
      appearance: appearance ?? {},
      persona: persona ?? {},
      skills: skills ?? [],
      attributes: { avatar_template: template },
    })
    .select('id, name, slug')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(data);
}
