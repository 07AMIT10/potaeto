import { CreateForm } from './CreateForm';
import { resolveUserId } from '@/lib/auth/resolveUserId';

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; seed?: string }>;
}) {
  const { userId, supabase: resolvedSupabase } = await resolveUserId();

  const { entity: entityId, seed } = await searchParams;
  let entity = null;
  if (entityId && userId) {
    const { data } = await resolvedSupabase
      .from('entities')
      .select('*')
      .eq('id', entityId)
      .eq('user_id', userId)
      .single();
    entity = data;
  }

  const entities = userId
    ? await resolvedSupabase
        .from('entities')
        .select('id, name, slug')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
    : { data: [] };

  const seedEntity = seed ? decodeURIComponent(seed) : null;

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="page-title">
          {entity ? `Edit ${entity.name}` : 'Create or edit'}
        </h1>
        <p className="text-[var(--muted)] text-sm mt-1">
          {entity ? 'Fine-tune your character details.' : 'Set up your character\'s profile and traits.'}
        </p>
      </div>
      <CreateForm entity={entity} entitiesList={entities.data ?? []} seed={seedEntity} />
    </div>
  );
}
