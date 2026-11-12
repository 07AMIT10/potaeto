import { createServiceClient } from '@/lib/supabase/server';
import { ADMIN_USAGE_LOGS_LIMIT, ORCHESTRATOR_URL } from '@/lib/config';
import { NextResponse } from 'next/server';
import { isAdminRequestAuthorized } from '@/lib/auth/adminAuth';

/**
 * PATCH /api/admin/models
 * Body: { id, enabled?, priority?, temperature?, max_output_tokens? }
 * Updates a single models_config row. Protected by ADMIN_SECRET.
 */
export async function PATCH(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { id, enabled, priority, temperature, max_output_tokens } = body as {
    id: string;
    enabled?: boolean;
    priority?: number;
    temperature?: number | null;
    max_output_tokens?: number | null;
  };

  if (!id) {
    return NextResponse.json({ error: 'Missing model id' }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof enabled === 'boolean') updates.enabled = enabled;
  if (typeof priority === 'number') updates.priority = priority;
  if (temperature !== undefined) updates.temperature = temperature;
  if (max_output_tokens !== undefined) updates.max_output_tokens = max_output_tokens;

  if (Object.keys(updates).length <= 1) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('models_config')
    .update(updates)
    .eq('id', id)
    .select('id, provider, model_key, task_type, priority, enabled, temperature, max_output_tokens')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  fetch(`${ORCHESTRATOR_URL}/v1/cache/invalidate`, { method: 'POST' }).catch(() => {});

  return NextResponse.json(data);
}

/**
 * GET /api/admin/models/usage-stats
 * Returns aggregated usage stats across ALL logs (not limited).
 */
export async function GET(request: Request) {
  if (!(await isAdminRequestAuthorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();

  const { count: totalLogs } = await supabase
    .from('model_usage_logs')
    .select('*', { count: 'exact', head: true });

  const { data: allLogs } = await supabase
    .from('model_usage_logs')
    .select('task_type, provider, model_key, success, latency_ms')
    .order('created_at', { ascending: false })
    .limit(ADMIN_USAGE_LOGS_LIMIT);

  type ProviderStats = { calls: number; errors: number; totalLatency: number; latencyCount: number };
  type TaskStats = { calls: number; errors: number };
  type ModelStats = { calls: number; errors: number; totalLatency: number; latencyCount: number; provider: string; model_key: string; task_type: string };

  const byProvider = new Map<string, ProviderStats>();
  const byTask = new Map<string, TaskStats>();
  const byModel = new Map<string, ModelStats>();

  for (const row of allLogs ?? []) {
    const lat = typeof row.latency_ms === 'number' ? row.latency_ms : 0;
    const hasLat = typeof row.latency_ms === 'number';

    const pKey = row.provider;
    const pCurr = byProvider.get(pKey) ?? { calls: 0, errors: 0, totalLatency: 0, latencyCount: 0 };
    byProvider.set(pKey, {
      calls: pCurr.calls + 1,
      errors: pCurr.errors + (row.success ? 0 : 1),
      totalLatency: pCurr.totalLatency + lat,
      latencyCount: pCurr.latencyCount + (hasLat ? 1 : 0),
    });

    const tKey = row.task_type;
    const tCurr = byTask.get(tKey) ?? { calls: 0, errors: 0 };
    byTask.set(tKey, { calls: tCurr.calls + 1, errors: tCurr.errors + (row.success ? 0 : 1) });

    const mKey = `${row.task_type}:${row.provider}:${row.model_key}`;
    const mCurr = byModel.get(mKey) ?? { calls: 0, errors: 0, totalLatency: 0, latencyCount: 0, provider: row.provider, model_key: row.model_key, task_type: row.task_type };
    byModel.set(mKey, {
      ...mCurr,
      calls: mCurr.calls + 1,
      errors: mCurr.errors + (row.success ? 0 : 1),
      totalLatency: mCurr.totalLatency + lat,
      latencyCount: mCurr.latencyCount + (hasLat ? 1 : 0),
    });
  }

  const providerArray = Array.from(byProvider.entries()).map(([name, s]) => ({
    name,
    calls: s.calls,
    errors: s.errors,
    successRate: s.calls > 0 ? Math.round(((s.calls - s.errors) / s.calls) * 100) : 0,
    avgLatency: s.latencyCount > 0 ? Math.round(s.totalLatency / s.latencyCount) : null,
  })).sort((a, b) => b.calls - a.calls);

  const taskArray = Array.from(byTask.entries()).map(([name, s]) => ({
    name,
    calls: s.calls,
    errors: s.errors,
  })).sort((a, b) => b.calls - a.calls);

  const modelArray = Array.from(byModel.values()).map((s) => ({
    key: `${s.task_type}:${s.provider}:${s.model_key}`,
    ...s,
    avgLatency: s.latencyCount > 0 ? Math.round(s.totalLatency / s.latencyCount) : null,
  })).sort((a, b) => b.calls - a.calls);

  return NextResponse.json({
    totalLogs: totalLogs ?? 0,
    byProvider: providerArray,
    byTask: taskArray,
    byModel: modelArray,
  });
}
