import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminModelsPage() {
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

  const byModel = new Map<string, { calls: number; errors: number; avgLatency: number | null }>();

  for (const row of usage ?? []) {
    const key = `${row.task_type}:${row.provider}:${row.model_key}`;
    const current = byModel.get(key) ?? { calls: 0, errors: 0, avgLatency: null };
    const latency = typeof row.latency_ms === 'number' ? row.latency_ms : null;
    const totalLatency = (current.avgLatency ?? 0) * current.calls + (latency ?? 0);
    const calls = current.calls + 1;
    const avgLatency = calls > 0 ? Math.round(totalLatency / calls) : null;
    byModel.set(key, { calls, errors: current.errors + (row.success ? 0 : 1), avgLatency });
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Models & Routing</h2>
        <p className="text-sm text-[var(--muted)] mt-1">Configured models and recent routing stats.</p>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Task</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Provider</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Model</th>
                <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Priority</th>
                <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Status</th>
                <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Temp</th>
                <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Max tokens</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Stats</th>
              </tr>
            </thead>
            <tbody>
              {(models ?? []).map((m) => {
                const key = `${m.task_type}:${m.provider}:${m.model_key}`;
                const stats = byModel.get(key);
                return (
                  <tr key={m.id} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3 whitespace-nowrap font-medium">{m.task_type}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{m.provider}</td>
                    <td className="px-4 py-3 font-mono text-[11px] break-all">{m.model_key}</td>
                    <td className="px-4 py-3 text-center">{m.priority}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        m.enabled
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-500'
                      }`}>
                        {m.enabled ? 'active' : 'off'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">{m.temperature ?? '\u2014'}</td>
                    <td className="px-4 py-3 text-center">{m.max_output_tokens ?? '\u2014'}</td>
                    <td className="px-4 py-3 text-[var(--muted)]">
                      {stats ? `${stats.calls} calls / ${stats.errors} err / ${stats.avgLatency ?? '\u2014'}ms` : '\u2014'}
                    </td>
                  </tr>
                );
              })}
              {(!models || models.length === 0) && (
                <tr>
                  <td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={8}>
                    No models configured. Seed the models_config table.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Editing models is currently done via SQL or Supabase dashboard.
      </p>
    </div>
  );
}
