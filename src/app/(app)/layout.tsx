import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--card-border)] bg-[var(--background)]/80 backdrop-blur-xl">
        <nav className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/onboarding" className="text-lg font-bold text-potato-600">
            Potaeto
          </Link>
          <div className="flex items-center gap-1">
            <Link href="/library" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
              Library
            </Link>
            <Link href="/share" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
              Share
            </Link>
            <form action="/api/auth/signout" method="post">
              <button type="submit" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}
