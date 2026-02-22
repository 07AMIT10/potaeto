import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { name, slug, characteristics, appearance, persona, skills } = body;
  const safeSlug = (slug || 'entity').toString().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'entity';

  const { data, error } = await supabase
    .from('entities')
    .insert({
      user_id: user.id,
      name: name || 'Unnamed',
      slug: safeSlug,
      characteristics: characteristics ?? {},
      appearance: appearance ?? {},
      persona: persona ?? {},
      skills: skills ?? [],
    })
    .select('id, name, slug')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json(data);
}
