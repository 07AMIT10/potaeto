import { createClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ChatUI } from './ChatUI';
import { SkillsSection } from '@/components/SkillsSection';

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

  const query = supabase
    .from('entities')
    .select('*')
    .eq('id', entityId)
    .limit(1)
    .single();

  const { data: entity } = await query;

  if (!entity) notFound();

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] animate-fade-in">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-[var(--card-border)]">
        <Link href="/create" className="btn-ghost text-[var(--muted)] p-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-8 h-8 rounded-full bg-potato-100 dark:bg-potato-900/30 flex items-center justify-center text-sm font-medium shrink-0">
            {entity.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <span className="text-sm font-semibold truncate block">{entity.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Link href={`/create?entity=${entityId}`} className="btn-ghost text-xs text-[var(--muted)] p-2" title="Edit">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </Link>
          <Link href={`/avatar/${entityId}`} className="btn-ghost text-xs text-[var(--muted)] p-2" title="Script & Voice">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
            </svg>
          </Link>
        </div>
      </div>

      <SkillsSection entityId={entityId} />
      <ChatUI entityId={entityId} entityName={entity.name} />
    </div>
  );
}
