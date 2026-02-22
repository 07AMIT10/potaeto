import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ChatUI } from './ChatUI';

export default async function ChatPage({
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
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex items-center gap-2 mb-4">
        <Link href="/create" className="text-sm text-gray-500 hover:text-potato-600">
          ← Back
        </Link>
        <span className="font-medium">{entity.name}</span>
        <Link
          href={`/avatar/${entityId}`}
          className="ml-auto text-sm text-potato-600 hover:underline"
        >
          Avatar / Script
        </Link>
      </div>
      <ChatUI entityId={entityId} entityName={entity.name} />
    </div>
  );
}
