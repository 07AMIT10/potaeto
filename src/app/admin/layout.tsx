import { headers } from 'next/headers';
import Link from 'next/link';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/models', label: 'Models & routing' },
  { href: '/admin/skills', label: 'Skills' },
  { href: '/admin/memory', label: 'Memory & logs' },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headersList = await headers();
  const provided = headersList.get('x-admin-secret');
  const expected = process.env.ADMIN_SECRET;

  if (expected && provided !== expected) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <p className="text-gray-500">
          Unauthorized. Set X-Admin-Secret header to ADMIN_SECRET.
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/80 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold text-potato-800 dark:text-potato-200">
            Admin
          </h1>
          <nav className="flex flex-wrap gap-1 sm:gap-2" aria-label="Admin sections">
            {ADMIN_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="rounded-lg px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-potato-600 dark:hover:text-potato-400"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <div className="max-w-5xl mx-auto px-4 py-8">{children}</div>
    </main>
  );
}
