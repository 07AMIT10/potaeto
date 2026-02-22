import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { AvatarScriptUI } from './AvatarScriptUI';

export default async function AvatarPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: entity } = await supabase
    .from('entities')
    .select('*')
    .eq('id', entityId)
    .eq('user_id', user.id)
    .single();

  if (!entity) notFound();

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Link href={`/chat/${entityId}`} className="text-sm text-gray-500 hover:text-potato-600">
          ← Chat
        </Link>
        <h1 className="text-xl font-bold text-potato-800">Script &amp; voice – {entity.name}</h1>
      </div>
      <AvatarScriptUI
        entityId={entityId}
        entityName={entity.name}
        avatarUrl={entity.avatar_asset_url}
      />
    </div>
  );
}
