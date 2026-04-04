import type { SupabaseClient } from '@supabase/supabase-js';

export function normalizeEntitySlug(input: unknown, fallback = 'entity'): string {
  const base = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return base || fallback;
}

export async function ensureUniqueEntitySlug(
  supabase: SupabaseClient,
  userId: string,
  desiredSlug: unknown,
  excludeEntityId?: string
): Promise<string> {
  const base = normalizeEntitySlug(desiredSlug);
  let query = supabase
    .from('entities')
    .select('id, slug')
    .eq('user_id', userId)
    .like('slug', `${base}%`);

  if (excludeEntityId) {
    query = query.neq('id', excludeEntityId);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []) as Array<{ id: string; slug: string }>;
  const taken = new Set<string>();
  for (const row of rows) {
    if (!row.slug) continue;
    taken.add(normalizeEntitySlug(row.slug, base));
  }

  if (!taken.has(base)) {
    return base;
  }

  let n = 2;
  while (taken.has(`${base}-${n}`)) {
    n += 1;
  }

  return `${base}-${n}`;
}
