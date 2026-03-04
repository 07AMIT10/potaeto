import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { ShareUI } from './ShareUI';

export default async function SharePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, slug, is_public')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const { data: content } = await supabase
    .from('content')
    .select('id, type, public_url, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(30);

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
