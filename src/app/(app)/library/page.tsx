import { createClient } from '@/lib/supabase/server';
import { LIBRARY_CONTENT_LIMIT } from '@/lib/config';
import { LibraryContent } from './LibraryContent';
import { GuestLibrary } from './GuestLibrary';

export default async function LibraryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="page-title">Library</h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            You&apos;re exploring as a guest. This view shows content stored in your browser only.
          </p>
        </div>
        <GuestLibrary />
      </div>
    );
  }

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
    .limit(LIBRARY_CONTENT_LIMIT);

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
