import { headers } from 'next/headers';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';

export default async function AdminMemoryPage() {
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

  const [{ data: summaries }, { data: memories }, { data: usage }] = await Promise.all([
    supabase
      .from('conversation_summaries')
      .select('conversation_id, user_id, entity_id, summary, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50),
    supabase
      .from('memories')
      .select('id, user_id, entity_id, kind, content, weight, created_at')
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('model_usage_logs')
      .select('created_at, task_type, provider, model_key, success, latency_ms, error_message')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  return (
    <main className="min-h-screen max-w-6xl mx-auto px-4 py-8 space-y-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-potato-800 mb-1">Admin – Memory & routing logs</h1>
          <p className="text-sm text-gray-500">
            Inspect conversation summaries, long-term memories, and recent model routing events.
          </p>
        </div>
        <Link href="/admin" className="text-sm text-potato-600 hover:underline">
          ← Back to overview
        </Link>
      </header>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Conversation summaries (latest 50)</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Conversation</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">User</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Entity</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Updated</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Summary</th>
              </tr>
            </thead>
            <tbody>
              {(summaries ?? []).map((s) => (
                <tr key={s.conversation_id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                    {s.conversation_id}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                    {s.user_id}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                    {s.entity_id}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {s.updated_at ? new Date(s.updated_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-xl">
                    {s.summary}
                  </td>
                </tr>
              ))}
              {(!summaries || summaries.length === 0) && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-xs text-gray-500"
                    colSpan={5}
                  >
                    No summaries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Memories (latest 50)</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Kind</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">User</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Entity</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Weight</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Created</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Content</th>
              </tr>
            </thead>
            <tbody>
              {(memories ?? []).map((m) => (
                <tr key={m.id} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 whitespace-nowrap">{m.kind}</td>
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                    {m.user_id}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] whitespace-nowrap">
                    {m.entity_id}
                  </td>
                  <td className="px-3 py-2 text-center">{m.weight ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {m.created_at ? new Date(m.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700 max-w-xl">
                    {m.content}
                  </td>
                </tr>
              ))}
              {(!memories || memories.length === 0) && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-xs text-gray-500"
                    colSpan={6}
                  >
                    No memories yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Model routing logs (latest 100)</h2>
        <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/60">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Time</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Task</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Provider</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Model</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Latency (ms)</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Success</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Error</th>
              </tr>
            </thead>
            <tbody>
              {(usage ?? []).map((u, idx) => (
                <tr key={idx} className="border-t border-gray-100 dark:border-gray-800">
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">
                    {u.created_at ? new Date(u.created_at).toLocaleTimeString() : '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{u.task_type}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{u.provider}</td>
                  <td className="px-3 py-2 font-mono text-[11px] break-all">{u.model_key}</td>
                  <td className="px-3 py-2 text-center">{u.latency_ms ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        u.success
                          ? 'inline-flex items-center rounded-full bg-green-50 text-green-700 px-2 py-0.5 text-[10px]'
                          : 'inline-flex items-center rounded-full bg-red-50 text-red-700 px-2 py-0.5 text-[10px]'
                      }
                    >
                      {u.success ? 'ok' : 'error'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[10px] text-red-500 max-w-xs">
                    {u.error_message}
                  </td>
                </tr>
              ))}
              {(!usage || usage.length === 0) && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-xs text-gray-500"
                    colSpan={7}
                  >
                    No routing logs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

