import React, { useEffect, useState } from 'react';
import type { OutboxEntry } from '@/lib/core/db';
import { useCore } from '@/components/providers/CoreProvider';

export function OutboxManager() {
  const { db, sync } = useCore();
  const [entries, setEntries] = useState<OutboxEntry[]>([]);
  const [flushing, setFlushing] = useState(false);

  async function loadEntries() {
    if (!db) return;
    const items = await db.outbox.toArray();
    setEntries(items);
  }

  useEffect(() => {
    loadEntries();
    const interval = setInterval(loadEntries, 2000);
    return () => clearInterval(interval);
  }, [db]);

  async function handleFlush() {
    setFlushing(true);
    try {
      await sync.flush();
      await loadEntries();
    } finally {
      setFlushing(false);
    }
  }

  async function handleClearAll() {
    if (!db) return;
    await db.outbox.clear();
    await loadEntries();
  }

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Offline Outbox</h3>
          <p className="text-xs text-zinc-500">
            {entries.length === 0 ? 'No pending offline changes' : `${entries.length} pending operation(s)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={handleClearAll}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-red-300 dark:border-red-900 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition"
            >
              Clear Outbox
            </button>
          )}
          <button
            type="button"
            disabled={flushing}
            onClick={handleFlush}
            className="text-xs px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium hover:bg-zinc-800 dark:hover:bg-white/90 transition disabled:opacity-50"
          >
            {flushing ? 'Syncing...' : 'Flush Now'}
          </button>
        </div>
      </div>

      {entries.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-48 overflow-y-auto">
          {entries.map((entry) => (
            <li key={entry.idempotencyKey} className="py-2 flex items-center justify-between text-xs font-mono">
              <div>
                <span className="font-semibold text-zinc-700 dark:text-zinc-300">{entry.entityType}</span>{' '}
                <span className="text-zinc-400">{entry.entityId}</span>
              </div>
              <span className="text-zinc-400">rev {entry.baseRev}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
