import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import type { GuestEntity, GuestContent } from '@/lib/guestStorage';
import { getCurrentAuthContext } from '@/lib/auth/appAuth';

type Payload = {
  entities: GuestEntity[];
  content: GuestContent[];
};

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const ctx = await getCurrentAuthContext(async () => user?.id ?? null);
  const userId = ctx.appUser?.id ?? ctx.supabaseUserId;

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { entities, content } = (await request.json()) as Partial<Payload>;
  const safeEntities = Array.isArray(entities) ? entities : [];
  const safeContent = Array.isArray(content) ? content : [];

  const service = createServiceClient();

  const entityIdMap: Record<string, string> = {};

  if (safeEntities.length > 0) {
    const rows = safeEntities.map((e) => ({
      user_id: userId,
      name: e.name,
      slug: e.slug,
      characteristics: {},
      appearance: {},
      persona: {},
      skills: [],
    }));
    const { data: inserted, error } = await service
      .from('entities')
      .insert(rows)
      .select('id')
      .order('created_at', { ascending: false })
      .limit(rows.length);

    if (!error && inserted) {
      inserted.forEach((row, idx) => {
        const guest = safeEntities[idx];
        if (guest) {
          entityIdMap[guest.id] = row.id;
        }
      });
    }
  }

  const contentIdMap: Record<string, string> = {};

  if (safeContent.length > 0) {
    const rows = safeContent.map((c) => ({
      user_id: userId,
      entity_id: c.entity_id ? entityIdMap[c.entity_id] ?? null : null,
      type: c.type,
      storage_path: null,
      public_url: c.public_url,
      metadata: c.metadata ?? {},
    }));

    const { data: insertedContent } = await service
      .from('content')
      .insert(rows)
      .select('id');

    if (insertedContent) {
      insertedContent.forEach((row, idx) => {
        const guest = safeContent[idx];
        if (guest) contentIdMap[guest.id] = row.id;
      });
    }
  }

  return NextResponse.json({ entityIdMap, contentIdMap });
}

