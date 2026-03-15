import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
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

  const { data: entity } = await supabase
    .from('entities')
    .select('*')
    .eq('id', entityId)
    .single();

  if (!entity) notFound();

  return (
    <div className="max-w-2xl mx-auto space-y-4 animate-fade-in">
      <div className="flex items-center gap-3">
        <Link href={`/chat/${entityId}`} className="btn-ghost text-[var(--muted)] p-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div>
          <h1 className="section-title">Script & Voice</h1>
          <p className="text-xs text-[var(--muted)]">{entity.name}</p>
        </div>
      </div>
      <AvatarScriptUI
        entityId={entityId}
        entityName={entity.name}
        avatarUrl={entity.avatar_asset_url}
      />
    </div>
  );
}
