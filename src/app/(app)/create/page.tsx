import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { CreateForm } from './CreateForm';

export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { entity: entityId } = await searchParams;
  let entity = null;
  if (entityId) {
    const { data } = await supabase
      .from('entities')
      .select('*')
      .eq('id', entityId)
      .eq('user_id', user.id)
      .single();
    entity = data;
  }

  const entities = await supabase
    .from('entities')
    .select('id, name, slug')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-potato-800">
        {entity ? `Edit ${entity.name}` : 'Create or edit WHO/WHAT'}
      </h1>
      <CreateForm entity={entity} entitiesList={entities.data ?? []} />
    </div>
  );
}
