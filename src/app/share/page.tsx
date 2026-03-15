import { SHARE_CONTENT_LIMIT } from '@/lib/config';
import { redirect } from 'next/navigation';
import { resolveUserId } from '@/lib/auth/resolveUserId';
import { ShareUI } from './ShareUI';

export default async function SharePage() {
  const { userId, supabase } = await resolveUserId();
  if (!userId) redirect('/login');

  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, slug, is_public')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const { data: content } = await supabase
    .from('content')
    .select('id, type, public_url, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(SHARE_CONTENT_LIMIT);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="page-title">Share</h1>
        <p className="text-[var(--muted)] text-sm mt-1">Manage your public profiles and content links.</p>
      </div>
      <ShareUI entities={entities ?? []} content={content ?? []} />
    </div>
  );
}
