import { createServiceClient } from '@/lib/supabase/server';
import Link from 'next/link';

export default async function AdminPage() {
  const supabase = createServiceClient();
  const [
    { count: usersCount },
    { count: entitiesCount },
    { count: contentCount },
    { count: conversationsCount },
    { count: messagesCount },
    { count: skillOutputsCount },
    { count: totalApiCalls },
    { data: recentLogs },
  ] = await Promise.all([
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('entities').select('*', { count: 'exact', head: true }),
    supabase.from('content').select('*', { count: 'exact', head: true }),
    supabase.from('conversations').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
    supabase.from('skill_outputs').select('*', { count: 'exact', head: true }),
    supabase.from('model_usage_logs').select('*', { count: 'exact', head: true }),
    supabase
      .from('model_usage_logs')
      .select('provider, success, latency_ms')
      .order('created_at', { ascending: false })
      .limit(1000),
  ]);

  const platformStats = [
    { label: 'Users', value: usersCount ?? 0, color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
    { label: 'Entities', value: entitiesCount ?? 0, color: 'bg-potato-100 dark:bg-potato-900/30 text-potato-600 dark:text-potato-400' },
    { label: 'Content', value: contentCount ?? 0, color: 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' },
    { label: 'Conversations', value: conversationsCount ?? 0, color: 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' },
    { label: 'Messages', value: messagesCount ?? 0, color: 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' },
    { label: 'Skill outputs', value: skillOutputsCount ?? 0, color: 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  ];

  const logs = recentLogs ?? [];
  const totalErrors = logs.filter((l) => !l.success).length;
  const successRate = logs.length > 0 ? Math.round(((logs.length - totalErrors) / logs.length) * 100) : 0;
  const byProvider = new Map<string, number>();
  for (const l of logs) {
    byProvider.set(l.provider, (byProvider.get(l.provider) ?? 0) + 1);
  }
  const topProvider = Array.from(byProvider.entries()).sort((a, b) => b[1] - a[1])[0];

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Overview</h2>
        <p className="text-sm text-[var(--muted)] mt-1">High-level platform metrics.</p>
      </div>

      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3">
        {platformStats.map((s) => (
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

      {/* Model usage health card */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Model usage</h3>
          <Link href="/admin/models" className="text-xs text-potato-600 hover:underline">
            View details &rarr;
          </Link>
        </div>
        <div className="card p-5">
          <div className="grid gap-6 sm:grid-cols-4">
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Total API calls</p>
              <p className="text-2xl font-bold">{(totalApiCalls ?? 0).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Recent errors</p>
              <p className="text-2xl font-bold text-red-500">{totalErrors}</p>
              <p className="text-[10px] text-[var(--muted)]">last 1k calls</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Success rate</p>
              <p className={`text-2xl font-bold ${successRate >= 95 ? 'text-green-600' : successRate >= 80 ? 'text-amber-500' : 'text-red-500'}`}>
                {successRate}%
              </p>
              <p className="text-[10px] text-[var(--muted)]">last 1k calls</p>
            </div>
            <div>
              <p className="text-xs text-[var(--muted)] mb-1">Top provider</p>
              <p className="text-2xl font-bold capitalize">{topProvider ? topProvider[0] : '\u2014'}</p>
              {topProvider && (
                <p className="text-[10px] text-[var(--muted)]">{topProvider[1]} calls ({logs.length > 0 ? Math.round((topProvider[1] / logs.length) * 100) : 0}%)</p>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="card p-4 text-xs text-[var(--muted)]">
        Admin is protected by <code className="bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">ADMIN_SECRET</code> header.
        Use the nav above to explore models, skills, and memory.
      </div>
    </div>
  );
}
