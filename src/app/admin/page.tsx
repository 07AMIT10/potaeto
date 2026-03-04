import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminPage() {
  const supabase = createServiceClient();
  const [
    { count: usersCount },
    { count: entitiesCount },
    { count: contentCount },
    { count: conversationsCount },
    { count: messagesCount },
    { count: skillOutputsCount },
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('entities').select('*', { count: 'exact', head: true }),
    supabase.from('content').select('*', { count: 'exact', head: true }),
    supabase.from('conversations').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
    supabase.from('skill_outputs').select('*', { count: 'exact', head: true }),
  ]);

  const stats = [
    { label: 'Users', value: usersCount ?? 0, color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
    { label: 'Entities', value: entitiesCount ?? 0, color: 'bg-potato-100 dark:bg-potato-900/30 text-potato-600 dark:text-potato-400' },
    { label: 'Content items', value: contentCount ?? 0, color: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' },
    { label: 'Conversations', value: conversationsCount ?? 0, color: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' },
    { label: 'Messages', value: messagesCount ?? 0, color: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' },
    { label: 'Skill outputs', value: skillOutputsCount ?? 0, color: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  ];

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Overview</h2>
        <p className="text-sm text-[var(--muted)] mt-1">High-level platform metrics.</p>
      </div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.label} className="card p-4">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold ${s.color}`}>
                {s.value}
              </div>
              <span className="text-sm text-[var(--muted)]">{s.label}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 text-xs text-[var(--muted)]">
        Admin is protected by <code className="bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">ADMIN_SECRET</code> header.
        Use the nav above to explore models, skills, and memory.
      </div>
    </div>
  );
}
