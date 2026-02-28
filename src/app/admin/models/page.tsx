import { headers } from 'next/headers';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminModelsPage() {
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

  const { data: models } = await supabase
    .from('models_config')
    .select('id, provider, model_key, task_type, priority, enabled, temperature, max_output_tokens')
    .order('task_type')
    .order('priority');

  const { data: usage } = await supabase
    .from('model_usage_logs')
    .select('task_type, provider, model_key, success, latency_ms')
    .order('created_at', { ascending: false })
    .limit(200);

  const byModel = new Map<
    string,
    { calls: number; errors: number; avgLatency: number | null }
  >();

  for (const row of usage ?? []) {
    const key = `${row.task_type}:${row.provider}:${row.model_key}`;
    const current = byModel.get(key) ?? { calls: 0, errors: 0, avgLatency: null };
    const latency = typeof row.latency_ms === 'number' ? row.latency_ms : null;
    const totalLatency =
      (current.avgLatency ?? 0) * current.calls + (latency ?? 0);
    const calls = current.calls + 1;
    const avgLatency = calls > 0 ? Math.round(totalLatency / calls) : null;
    byModel.set(key, {
      calls,
      errors: current.errors + (row.success ? 0 : 1),
      avgLatency,
    });
  }

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-4 py-8 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-potato-800 mb-1">Admin – Models & routing</h1>
          <p className="text-sm text-gray-500">
            View configured models by task type and recent routing stats.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-potato-600 hover:underline">
          ← Back to overview
        </Link>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Configured models</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Task</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Provider</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Model key</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Priority</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Enabled</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Temp</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Max tokens</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Calls / Errors / Avg ms</th>
              </tr>
            </thead>
            <tbody>
              {(models ?? []).map((m) => {
                const key = `${m.task_type}:${m.provider}:${m.model_key}`;
                const stats = byModel.get(key);
                return (
                  <tr key={m.id} className="border-t border-gray-100 dark:border-gray-800">
                    <td className="px-3 py-2 whitespace-nowrap">{m.task_type}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{m.provider}</td>
                    <td className="px-3 py-2 font-mono text-[11px] break-all">{m.model_key}</td>
                    <td className="px-3 py-2 text-center">{m.priority}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          m.enabled
                            ? 'inline-flex items-center rounded-full bg-green-50 text-green-700 px-2 py-0.5 text-[10px]'
                            : 'inline-flex items-center rounded-full bg-gray-100 text-gray-500 px-2 py-0.5 text-[10px]'
                        }
                      >
                        {m.enabled ? 'enabled' : 'disabled'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">{m.temperature ?? '—'}</td>
                    <td className="px-3 py-2 text-center">{m.max_output_tokens ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {stats
                        ? `${stats.calls} / ${stats.errors} / ${
                            stats.avgLatency !== null ? stats.avgLatency : '—'
                          }`
                        : '—'}
                    </td>
                  </tr>
                );
              })}
              {(!models || models.length === 0) && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-xs text-gray-500"
                    colSpan={8}
                  >
                    No models configured yet. Seed the models_config table to start routing.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-500">
          Editing (add / remove / toggle models) is currently done via SQL or Supabase dashboard.
        </p>
      </section>
    </main>
  );
}

