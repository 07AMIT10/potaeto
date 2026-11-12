import { LIBRARY_CONTENT_LIMIT } from '@/lib/config';
import { LibraryContent } from './LibraryContent';
import { GuestLibrary } from './GuestLibrary';
import { resolveUserId } from '@/lib/auth/resolveUserId';

export default async function LibraryPage() {
  const { userId, supabase } = await resolveUserId();
  if (!userId) {
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
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  const { data: content } = await supabase
    .from('content')
    .select('id, type, public_url, metadata, created_at, entity_id')
    .eq('user_id', userId)
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
