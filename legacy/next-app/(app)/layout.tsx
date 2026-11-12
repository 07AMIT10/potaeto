import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getCurrentAuthContext } from '@/lib/auth/appAuth';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const authCtx = await getCurrentAuthContext(async () => user?.id ?? null);

  const isGuest = authCtx.mode === 'guest';

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--card-border)] bg-[var(--background)]/80 backdrop-blur-xl">
        <nav className="max-w-5xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link href="/onboarding" className="text-lg font-bold text-potato-600">
            Potaeto
          </Link>
          <div className="flex items-center gap-3">
            {isGuest && (
              <span className="hidden sm:inline-flex items-center gap-1 rounded-full border border-dashed border-[var(--card-border)] px-3 py-1 text-[10px] font-medium text-[var(--muted)] uppercase tracking-wide">
                Guest session
              </span>
            )}
            <Link href="/library" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
              Library
            </Link>
            <Link href="/share" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
              Share
            </Link>
            {isGuest ? (
              <Link href="/login" className="btn-ghost text-xs sm:text-sm text-potato-600">
                Log in
              </Link>
            ) : (
              <form action="/api/app-auth/logout" method="post">
                <button type="submit" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
                  Sign out
                </button>
              </form>
            )}
          </div>
        </nav>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}
