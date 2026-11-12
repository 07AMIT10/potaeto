import { NextResponse } from 'next/server';
import { resolveUserId } from '@/lib/auth/resolveUserId';
import { ensureUniqueEntitySlug } from '@/lib/entities/slug';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const { entityId: id } = await params;
  const { userId, supabase } = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, slug, characteristics, appearance, persona, skills, is_public, avatar_template } = body;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) {
    updates.slug = await ensureUniqueEntitySlug(supabase, userId, slug, id);
  }
  if (characteristics !== undefined) updates.characteristics = characteristics;
  if (appearance !== undefined) updates.appearance = appearance;
  if (persona !== undefined) updates.persona = persona;
  if (skills !== undefined) updates.skills = skills;
  if (typeof is_public === 'boolean') updates.is_public = is_public;

  if (avatar_template !== undefined) {
    const { data: row } = await supabase
      .from('entities')
      .select('attributes')
      .eq('id', id)
      .eq('user_id', userId)
      .single();
    const attrs = (row?.attributes as Record<string, unknown> | null) ?? {};
    const template = avatar_template === 'cat' ? 'cat' : 'potato';
    updates.attributes = { ...attrs, avatar_template: template };
  }

  const { data, error } = await supabase
    .from('entities')
    .update(updates)
    .eq('id', id)
    .eq('user_id', userId)
    .select('id, name, slug')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entityId: string }> }
) {
  const { entityId: id } = await params;
  const { userId, supabase } = await resolveUserId();
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('entities')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}
