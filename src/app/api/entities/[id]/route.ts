import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, slug, characteristics, appearance, persona, skills, is_public } = body;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (slug !== undefined) updates.slug = slug;
  if (characteristics !== undefined) updates.characteristics = characteristics;
  if (appearance !== undefined) updates.appearance = appearance;
  if (persona !== undefined) updates.persona = persona;
  if (skills !== undefined) updates.skills = skills;
  if (typeof is_public === 'boolean') updates.is_public = is_public;

  const { data, error } = await supabase
    .from('entities')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id, name, slug')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('entities')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(data);
}
