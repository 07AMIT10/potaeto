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
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur">
        <nav className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link href="/onboarding" className="font-semibold text-potato-700">
            Potaeto
          </Link>
          <div className="flex gap-4 text-sm">
            <Link href="/library" className="text-gray-600 dark:text-gray-400 hover:text-potato-600">
              Library
            </Link>
            <Link href="/share" className="text-gray-600 dark:text-gray-400 hover:text-potato-600">
              Share
            </Link>
            <form action="/api/auth/signout" method="post">
              <button type="submit" className="text-gray-600 dark:text-gray-400 hover:text-potato-600">
                Sign out
              </button>
            </form>
          </div>
        </nav>
      </header>
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
