import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminPage() {
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
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-potato-800 dark:text-potato-200 mb-1">
          Overview
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          High-level metrics. Use the nav above for models, skills, and memory.
        </p>
      </div>

      <section>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500 dark:text-gray-400">Users</p>
            <p className="text-2xl font-semibold">{usersCount ?? 0}</p>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500 dark:text-gray-400">Entities (WHO/WHAT)</p>
            <p className="text-2xl font-semibold">{entitiesCount ?? 0}</p>
          </div>
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800/50">
            <p className="text-sm text-gray-500 dark:text-gray-400">Content items</p>
            <p className="text-2xl font-semibold">{contentCount ?? 0}</p>
          </div>
        </div>
        <p className="mt-6 text-sm text-gray-500 dark:text-gray-400">
          Admin is protected by ADMIN_SECRET (header X-Admin-Secret).
        </p>
      </section>
    </div>
  );
}
