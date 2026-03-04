'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';

interface ModelRow {
  id: string;
  provider: string;
  model_key: string;
  display_name: string | null;
  task_type: string;
  priority: number;
  enabled: boolean;
  temperature: number | null;
  max_output_tokens: number | null;
}

interface LogRow {
  task_type: string;
  provider: string;
  model_key: string;
  success: boolean;
  latency_ms: number | null;
}

interface Props {
  initialModels: ModelRow[];
  initialLogs: LogRow[];
}

type ProviderStat = { name: string; calls: number; errors: number; avgLatency: number | null; successRate: number };
type TaskStat = { name: string; calls: number; errors: number };
type ModelStat = { calls: number; errors: number; avgLatency: number | null };

function computeStats(logs: LogRow[]) {
  const byProvider = new Map<string, { calls: number; errors: number; totalLat: number; latCount: number }>();
  const byTask = new Map<string, { calls: number; errors: number }>();
  const byModel = new Map<string, { calls: number; errors: number; totalLat: number; latCount: number }>();

  for (const r of logs) {
    const lat = typeof r.latency_ms === 'number' ? r.latency_ms : 0;
    const hasLat = typeof r.latency_ms === 'number';
    const isErr = !r.success;

    const p = byProvider.get(r.provider) ?? { calls: 0, errors: 0, totalLat: 0, latCount: 0 };
    byProvider.set(r.provider, { calls: p.calls + 1, errors: p.errors + (isErr ? 1 : 0), totalLat: p.totalLat + lat, latCount: p.latCount + (hasLat ? 1 : 0) });

    const t = byTask.get(r.task_type) ?? { calls: 0, errors: 0 };
    byTask.set(r.task_type, { calls: t.calls + 1, errors: t.errors + (isErr ? 1 : 0) });

    const mKey = `${r.task_type}:${r.provider}:${r.model_key}`;
    const m = byModel.get(mKey) ?? { calls: 0, errors: 0, totalLat: 0, latCount: 0 };
    byModel.set(mKey, { calls: m.calls + 1, errors: m.errors + (isErr ? 1 : 0), totalLat: m.totalLat + lat, latCount: m.latCount + (hasLat ? 1 : 0) });
  }

  const providers: ProviderStat[] = Array.from(byProvider.entries())
    .map(([name, s]) => ({
      name,
      calls: s.calls,
      errors: s.errors,
      successRate: s.calls > 0 ? Math.round(((s.calls - s.errors) / s.calls) * 100) : 0,
      avgLatency: s.latCount > 0 ? Math.round(s.totalLat / s.latCount) : null,
    }))
    .sort((a, b) => b.calls - a.calls);

  const tasks: TaskStat[] = Array.from(byTask.entries())
    .map(([name, s]) => ({ name, calls: s.calls, errors: s.errors }))
    .sort((a, b) => b.calls - a.calls);

  const models: Map<string, ModelStat> = new Map();
  byModel.forEach((s, key) => {
    models.set(key, { calls: s.calls, errors: s.errors, avgLatency: s.latCount > 0 ? Math.round(s.totalLat / s.latCount) : null });
  });

  const totalCalls = logs.length;
  const totalErrors = logs.filter((r) => !r.success).length;

  return { providers, tasks, models, totalCalls, totalErrors };
}

interface HealthEntry {
  provider: string;
  model_key: string;
  success_rate: number;
  is_cooling_down: boolean;
  cooldown_remaining_sec: number;
  consecutive_rate_limits: number;
  consecutive_errors: number;
  total_calls: number;
  total_errors: number;
  total_rate_limits: number;
  health_penalty: number;
}

export function ModelsAdmin({ initialModels, initialLogs }: Props) {
  const [models, setModels] = useState(initialModels);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingRow, setEditingRow] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ priority: number; temperature: string; max_output_tokens: string }>({ priority: 0, temperature: '', max_output_tokens: '' });
  const [liveHealth, setLiveHealth] = useState<HealthEntry[]>([]);
  const [healthError, setHealthError] = useState<string | null>(null);

  const stats = useMemo(() => computeStats(initialLogs), [initialLogs]);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/admin/health');
        if (!res.ok) {
          setHealthError('Orchestrator offline');
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setLiveHealth(data.providers ?? []);
          setHealthError(null);
        }
      } catch {
        if (!cancelled) setHealthError('Cannot reach orchestrator');
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const updateModel = useCallback(async (id: string, updates: Record<string, unknown>) => {
    setSaving(id);
    try {
      const res = await fetch('/api/admin/models', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      if (res.ok) {
        const updated = await res.json();
        setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...updated } : m)));
      }
    } finally {
      setSaving(null);
    }
  }, []);

  const toggleEnabled = useCallback((m: ModelRow) => {
    updateModel(m.id, { enabled: !m.enabled });
  }, [updateModel]);

  const startEdit = useCallback((m: ModelRow) => {
    setEditingRow(m.id);
    setEditValues({
      priority: m.priority,
      temperature: m.temperature?.toString() ?? '',
      max_output_tokens: m.max_output_tokens?.toString() ?? '',
    });
  }, []);

  const saveEdit = useCallback(async (id: string) => {
    const updates: Record<string, unknown> = {};
    updates.priority = editValues.priority;
    updates.temperature = editValues.temperature ? parseFloat(editValues.temperature) : null;
    updates.max_output_tokens = editValues.max_output_tokens ? parseInt(editValues.max_output_tokens, 10) : null;
    await updateModel(id, updates);
    setEditingRow(null);
  }, [editValues, updateModel]);

  const cancelEdit = useCallback(() => setEditingRow(null), []);

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Models & Routing</h2>
        <p className="text-sm text-[var(--muted)] mt-1">Usage stats, model config, and inline editing.</p>
      </div>

      {/* Top-level stats */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)] mb-1">Total API calls</p>
          <p className="text-2xl font-bold">{stats.totalCalls.toLocaleString()}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)] mb-1">Errors</p>
          <p className="text-2xl font-bold text-red-500">{stats.totalErrors.toLocaleString()}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)] mb-1">Success rate</p>
          <p className="text-2xl font-bold text-green-600">
            {stats.totalCalls > 0 ? Math.round(((stats.totalCalls - stats.totalErrors) / stats.totalCalls) * 100) : 0}%
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-[var(--muted)] mb-1">Providers active</p>
          <p className="text-2xl font-bold">{stats.providers.length}</p>
        </div>
      </div>

      {/* Per-provider breakdown */}
      {stats.providers.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Usage by provider</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stats.providers.map((p) => (
              <div key={p.name} className="card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold capitalize">{p.name}</span>
                  <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                    p.successRate >= 95 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' :
                    p.successRate >= 80 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                    'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                  }`}>
                    {p.successRate}% success
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <p className="text-[var(--muted)]">Calls</p>
                    <p className="font-semibold">{p.calls.toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-[var(--muted)]">Errors</p>
                    <p className="font-semibold text-red-500">{p.errors}</p>
                  </div>
                  <div>
                    <p className="text-[var(--muted)]">Avg ms</p>
                    <p className="font-semibold">{p.avgLatency ?? '\u2014'}</p>
                  </div>
                </div>
                {/* Usage bar */}
                {stats.totalCalls > 0 && (
                  <div className="h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-potato-400"
                      style={{ width: `${Math.round((p.calls / stats.totalCalls) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Live provider health from orchestrator */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Live provider health</h3>
          <span className="text-[10px] text-[var(--muted)]">Auto-refreshes every 10s</span>
        </div>
        {healthError ? (
          <div className="card p-4 text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            {healthError} &mdash; smart routing runs inside the orchestrator. Start it to see live health.
          </div>
        ) : liveHealth.length === 0 ? (
          <div className="card p-4 text-sm text-[var(--muted)]">No routing data yet. Make some API calls first.</div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted)]">Provider</th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted)]">Model</th>
                    <th className="px-4 py-2.5 text-center font-medium text-[var(--muted)]">Health</th>
                    <th className="px-4 py-2.5 text-center font-medium text-[var(--muted)]">Status</th>
                    <th className="px-4 py-2.5 text-center font-medium text-[var(--muted)]">Cooldown</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--muted)]">Rate limits</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--muted)]">Errors (consec)</th>
                    <th className="px-4 py-2.5 text-center font-medium text-[var(--muted)]">Penalty</th>
                  </tr>
                </thead>
                <tbody>
                  {liveHealth.map((h) => (
                    <tr key={`${h.provider}:${h.model_key}`} className={`border-b border-[var(--card-border)] last:border-0 ${h.is_cooling_down ? 'bg-red-50/50 dark:bg-red-900/10' : ''}`}>
                      <td className="px-4 py-2.5 capitalize font-medium">{h.provider}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px]">{h.model_key}</td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                          h.success_rate >= 90 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300' :
                          h.success_rate >= 50 ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                          'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                        }`}>
                          {h.success_rate}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {h.is_cooling_down ? (
                          <span className="inline-flex items-center gap-1 text-red-500 font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                            cooling
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-green-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            ready
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center text-[var(--muted)]">
                        {h.cooldown_remaining_sec > 0 ? `${h.cooldown_remaining_sec}s` : '\u2014'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {h.total_rate_limits > 0 ? (
                          <span className="text-red-500 font-medium">{h.total_rate_limits} ({h.consecutive_rate_limits} consec)</span>
                        ) : (
                          <span className="text-[var(--muted)]">0</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {h.consecutive_errors > 0 ? (
                          <span className="text-amber-500 font-medium">{h.consecutive_errors}</span>
                        ) : (
                          <span className="text-[var(--muted)]">0</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {h.health_penalty > 0 ? (
                          <span className="text-red-500 font-medium">+{h.health_penalty}</span>
                        ) : (
                          <span className="text-green-600">0</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-[10px] text-[var(--muted)] leading-relaxed max-w-3xl">
          The smart router skips models in cooldown and re-ranks by effective priority (base + health penalty).
          A 429 rate-limit triggers exponential cooldown (15s &rarr; 5min). Other errors use shorter cooldown (3s &rarr; 30s).
          When all healthy models fail, cooling-down models are tried as last resort (nearest-to-recovery first).
        </p>
      </section>

      {/* Per-task breakdown */}
      {stats.tasks.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Usage by task type</h3>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted)]">Task type</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--muted)]">Calls</th>
                    <th className="px-4 py-2.5 text-right font-medium text-[var(--muted)]">Errors</th>
                    <th className="px-4 py-2.5 text-left font-medium text-[var(--muted)]">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.tasks.map((t) => (
                    <tr key={t.name} className="border-b border-[var(--card-border)] last:border-0">
                      <td className="px-4 py-2.5 font-medium">{t.name}</td>
                      <td className="px-4 py-2.5 text-right">{t.calls.toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-right text-red-500">{t.errors}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden max-w-[100px]">
                            <div
                              className="h-full rounded-full bg-potato-400"
                              style={{ width: `${stats.totalCalls > 0 ? Math.round((t.calls / stats.totalCalls) * 100) : 0}%` }}
                            />
                          </div>
                          <span className="text-[var(--muted)]">{stats.totalCalls > 0 ? Math.round((t.calls / stats.totalCalls) * 100) : 0}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Models config table with inline editing */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">Configured models</h3>
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
                  <th className="px-4 py-3 text-right font-medium text-[var(--muted)]">Calls</th>
                  <th className="px-4 py-3 text-right font-medium text-[var(--muted)]">Errors</th>
                  <th className="px-4 py-3 text-right font-medium text-[var(--muted)]">Avg ms</th>
                  <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => {
                  const mKey = `${m.task_type}:${m.provider}:${m.model_key}`;
                  const mStats = stats.models.get(mKey);
                  const isEditing = editingRow === m.id;
                  const isSaving = saving === m.id;

                  return (
                    <tr key={m.id} className={`border-b border-[var(--card-border)] last:border-0 ${!m.enabled ? 'opacity-50' : ''} ${isSaving ? 'animate-pulse' : ''}`}>
                      <td className="px-4 py-3 whitespace-nowrap font-medium">{m.task_type}</td>
                      <td className="px-4 py-3 whitespace-nowrap capitalize">{m.provider}</td>
                      <td className="px-4 py-3 font-mono text-[11px] break-all max-w-[180px]">{m.model_key}</td>

                      {/* Priority */}
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <input
                            type="number"
                            value={editValues.priority}
                            onChange={(e) => setEditValues((v) => ({ ...v, priority: parseInt(e.target.value, 10) || 0 }))}
                            className="w-16 text-center rounded border border-[var(--card-border)] bg-transparent px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-potato-400"
                          />
                        ) : (
                          <span className="inline-flex items-center justify-center w-8 h-6 rounded bg-black/5 dark:bg-white/5 font-mono font-semibold">{m.priority}</span>
                        )}
                      </td>

                      {/* Enabled toggle */}
                      <td className="px-4 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => toggleEnabled(m)}
                          disabled={isSaving}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-potato-400 focus:ring-offset-1 ${
                            m.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
                          }`}
                          role="switch"
                          aria-checked={m.enabled}
                        >
                          <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ${
                            m.enabled ? 'translate-x-4' : 'translate-x-0.5'
                          } mt-0.5`} />
                        </button>
                      </td>

                      {/* Temperature */}
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.1"
                            value={editValues.temperature}
                            onChange={(e) => setEditValues((v) => ({ ...v, temperature: e.target.value }))}
                            placeholder="\u2014"
                            className="w-16 text-center rounded border border-[var(--card-border)] bg-transparent px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-potato-400"
                          />
                        ) : (
                          <span>{m.temperature ?? '\u2014'}</span>
                        )}
                      </td>

                      {/* Max tokens */}
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <input
                            type="number"
                            value={editValues.max_output_tokens}
                            onChange={(e) => setEditValues((v) => ({ ...v, max_output_tokens: e.target.value }))}
                            placeholder="\u2014"
                            className="w-20 text-center rounded border border-[var(--card-border)] bg-transparent px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-potato-400"
                          />
                        ) : (
                          <span>{m.max_output_tokens ?? '\u2014'}</span>
                        )}
                      </td>

                      {/* Stats columns */}
                      <td className="px-4 py-3 text-right font-medium">{mStats?.calls.toLocaleString() ?? '\u2014'}</td>
                      <td className="px-4 py-3 text-right">{mStats ? <span className={mStats.errors > 0 ? 'text-red-500 font-medium' : ''}>{mStats.errors}</span> : '\u2014'}</td>
                      <td className="px-4 py-3 text-right text-[var(--muted)]">{mStats?.avgLatency ?? '\u2014'}</td>

                      {/* Actions */}
                      <td className="px-4 py-3 text-center">
                        {isEditing ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => saveEdit(m.id)}
                              disabled={isSaving}
                              className="rounded px-2 py-1 text-[10px] font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="rounded px-2 py-1 text-[10px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => startEdit(m)}
                            className="rounded px-2 py-1 text-[10px] font-medium text-potato-600 hover:bg-potato-50 dark:hover:bg-potato-900/20 transition-colors"
                          >
                            Edit
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {models.length === 0 && (
                  <tr>
                    <td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={11}>
                      No models configured. Seed the models_config table.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <p className="text-xs text-[var(--muted)]">
        Toggle switches update immediately. Click Edit to change priority, temperature, or max tokens.
        Lower priority number = tried first. Disabled models are skipped by the orchestrator.
      </p>
    </div>
  );
}
