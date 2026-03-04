import { createServiceClient } from '@/lib/supabase/server';
import { ADMIN_MEMORY_LIMIT, ADMIN_ROUTING_LOGS_LIMIT } from '@/lib/config';

function truncateId(id: string) {
  return id.length > 12 ? id.slice(0, 8) + '\u2026' : id;
}

export default async function AdminMemoryPage() {
  const supabase = createServiceClient();

  const [{ data: summaries }, { data: memories }, { data: usage }] = await Promise.all([
    supabase
      .from('conversation_summaries')
      .select('conversation_id, user_id, entity_id, summary, updated_at')
      .order('updated_at', { ascending: false })
      .limit(ADMIN_MEMORY_LIMIT),
    supabase
      .from('memories')
      .select('id, user_id, entity_id, kind, content, weight, created_at')
      .order('created_at', { ascending: false })
      .limit(ADMIN_MEMORY_LIMIT),
    supabase
      .from('model_usage_logs')
      .select('created_at, task_type, provider, model_key, success, latency_ms, error_message')
      .order('created_at', { ascending: false })
      .limit(ADMIN_ROUTING_LOGS_LIMIT),
  ]);

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h2 className="page-title">Memory & Logs</h2>
        <p className="text-sm text-[var(--muted)] mt-1">Conversation summaries, long-term memories, and routing logs.</p>
      </div>

      <section className="space-y-3">
        <h3 className="section-title text-base">Conversation Summaries</h3>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Conversation</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Updated</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Summary</th>
                </tr>
              </thead>
              <tbody>
                {(summaries ?? []).map((s) => (
                  <tr key={s.conversation_id} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3 font-mono text-[11px]" title={s.conversation_id}>{truncateId(s.conversation_id)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {s.updated_at ? new Date(s.updated_at).toLocaleString() : '\u2014'}
                    </td>
                    <td className="px-4 py-3 max-w-md">{s.summary}</td>
                  </tr>
                ))}
                {(!summaries || summaries.length === 0) && (
                  <tr><td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={3}>No summaries yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="section-title text-base">Memories</h3>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Kind</th>
                  <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Weight</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Created</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Content</th>
                </tr>
              </thead>
              <tbody>
                {(memories ?? []).map((m) => (
                  <tr key={m.id} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        m.kind === 'fact' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' :
                        m.kind === 'preference' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' :
                        m.kind === 'event' ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300' :
                        'bg-gray-100 dark:bg-gray-800 text-gray-600'
                      }`}>
                        {m.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">{m.weight ?? '\u2014'}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {m.created_at ? new Date(m.created_at).toLocaleString() : '\u2014'}
                    </td>
                    <td className="px-4 py-3 max-w-md">{m.content}</td>
                  </tr>
                ))}
                {(!memories || memories.length === 0) && (
                  <tr><td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={4}>No memories yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="section-title text-base">Model Routing Logs</h3>
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--card-border)] bg-black/[0.02] dark:bg-white/[0.02]">
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Time</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Task</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Provider</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Model</th>
                  <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">ms</th>
                  <th className="px-4 py-3 text-center font-medium text-[var(--muted)]">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-[var(--muted)]">Error</th>
                </tr>
              </thead>
              <tbody>
                {(usage ?? []).map((u, idx) => (
                  <tr key={idx} className="border-b border-[var(--card-border)] last:border-0">
                    <td className="px-4 py-3 whitespace-nowrap text-[var(--muted)]">
                      {u.created_at ? new Date(u.created_at).toLocaleTimeString() : '\u2014'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{u.task_type}</td>
                    <td className="px-4 py-3 whitespace-nowrap">{u.provider}</td>
                    <td className="px-4 py-3 font-mono text-[11px]">{u.model_key}</td>
                    <td className="px-4 py-3 text-center">{u.latency_ms ?? '\u2014'}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[10px] font-medium ${
                        u.success
                          ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                          : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                      }`}>
                        {u.success ? 'ok' : 'error'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[10px] text-red-500 max-w-xs">{u.error_message}</td>
                  </tr>
                ))}
                {(!usage || usage.length === 0) && (
                  <tr><td className="px-4 py-8 text-center text-[var(--muted)]" colSpan={7}>No routing logs yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
