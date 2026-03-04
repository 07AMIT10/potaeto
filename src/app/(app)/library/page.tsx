import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { LibraryContent } from './LibraryContent';

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, slug')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  const { data: content } = await supabase
    .from('content')
    .select('id, type, public_url, metadata, created_at, entity_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="page-title">Library</h1>
        <p className="text-[var(--muted)] text-sm mt-1">Generate and browse your content.</p>
      </div>
      <LibraryContent entities={entities ?? []} content={content ?? []} />
    </div>
  );
}
