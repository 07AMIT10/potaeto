import Link from 'next/link';
import { AdminLoginCard } from './AdminLoginCard';
import { isAdminSessionValid } from '@/lib/auth/adminAuth';

const ADMIN_LINKS = [
  { href: '/admin', label: 'Overview', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { href: '/admin/models', label: 'Models', icon: 'M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z' },
  { href: '/admin/skills', label: 'Skills', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { href: '/admin/memory', label: 'Memory & Logs', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4' },
] as const;

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const hasSession = await isAdminSessionValid();
  if (!hasSession) {
    return <AdminLoginCard />;
  }

  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--card-border)] bg-[var(--background)]/80 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <h1 className="text-lg font-bold text-potato-600">Admin</h1>
          <nav className="flex items-center gap-0.5" aria-label="Admin sections">
            {ADMIN_LINKS.map(({ href, label, icon }) => (
              <Link
                key={href}
                href={href}
                className="btn-ghost text-xs sm:text-sm text-[var(--muted)] flex items-center gap-1.5 px-2.5 sm:px-3 py-2"
              >
                <svg className="w-3.5 h-3.5 hidden sm:block" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={icon} />
                </svg>
                {label}
              </Link>
            ))}
            <form action="/api/admin/logout" method="post" className="ml-2">
              <button type="submit" className="btn-ghost text-xs sm:text-sm text-[var(--muted)]">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">{children}</div>
    </main>
  );
}
