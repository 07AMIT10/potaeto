import { headers } from 'next/headers';
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
    <main className="min-h-screen max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-potato-800 mb-6">Admin – Metrics</h1>
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
        Protect this page with ADMIN_SECRET (e.g. send header X-Admin-Secret or set in env).
      </p>
    </main>
  );
}
