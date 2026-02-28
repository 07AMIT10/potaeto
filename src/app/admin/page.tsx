import { headers } from 'next/headers';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminPage() {
  const headersList = await headers();
  const provided = headersList.get('x-admin-secret');
  const expected = process.env.ADMIN_SECRET;
  if (expected && provided !== expected) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <p className="text-gray-500">Unauthorized. Set X-Admin-Secret header to ADMIN_SECRET.</p>
      </main>
    );
  }

  const supabase = createServiceClient();
  const [
    { count: usersCount },
    { count: entitiesCount },
    { count: contentCount },
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('entities').select('*', { count: 'exact', head: true }),
    supabase.from('content').select('*', { count: 'exact', head: true }),
  ]);

  return (
    <main className="min-h-screen max-w-4xl mx-auto px-4 py-8 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-potato-800 mb-1">Admin – Overview</h1>
          <p className="text-sm text-gray-500">
            High-level metrics plus links to models, skills, and memory dashboards.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link href="/admin/models" className="text-potato-600 hover:underline">
            Models & routing
          </Link>
          <Link href="/admin/skills" className="text-potato-600 hover:underline">
            Skills
          </Link>
          <Link href="/admin/memory" className="text-potato-600 hover:underline">
            Memory & logs
          </Link>
        </nav>
      </header>

      <section>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500">Users</p>
            <p className="text-2xl font-semibold">{usersCount ?? 0}</p>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500">Entities (WHO/WHAT)</p>
            <p className="text-2xl font-semibold">{entitiesCount ?? 0}</p>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500">Content items</p>
            <p className="text-2xl font-semibold">{contentCount ?? 0}</p>
          </div>
        </div>
        <p className="mt-6 text-sm text-gray-500">
          Protect this area with ADMIN_SECRET (send header X-Admin-Secret or set in env).
        </p>
      </section>
    </main>
  );
}
