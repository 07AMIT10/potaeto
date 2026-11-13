import React, { useState } from 'react';
import type { PushConflict } from '@/lib/core/types';

export interface ConflictModalProps {
  conflict: PushConflict | null;
  onResolve: (action: 'keep_local' | 'accept_server') => Promise<void>;
  onClose: () => void;
}

export function ConflictModal({ conflict, onResolve, onClose }: ConflictModalProps) {
  const [resolving, setResolving] = useState(false);

  if (!conflict) return null;

  async function handleAction(action: 'keep_local' | 'accept_server') {
    setResolving(true);
    try {
      await onResolve(action);
      onClose();
    } finally {
      setResolving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-6 shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 pb-3">
          <div className="flex items-center gap-2">
            <span className="flex h-3 w-3 rounded-full bg-amber-500 animate-pulse" />
            <h2 id="conflict-modal-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
              Sync Conflict Detected
            </h2>
          </div>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300">
            {conflict.entityType}
          </span>
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Another device updated this {conflict.entityType} while you were offline. The server has advanced to revision{' '}
          <span className="font-mono font-medium text-zinc-900 dark:text-zinc-200">rev {conflict.serverRev ?? '?'}</span>{' '}
          (your base was rev {conflict.baseRev}).
        </p>

        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Your Offline Changes</label>
          <pre className="p-3 rounded-lg bg-zinc-100 dark:bg-zinc-800/80 text-xs font-mono text-zinc-800 dark:text-zinc-200 overflow-x-auto max-h-40 border border-zinc-200 dark:border-zinc-700">
            {JSON.stringify(conflict.localPayload, null, 2)}
          </pre>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 pt-2">
          <button
            type="button"
            disabled={resolving}
            onClick={() => handleAction('accept_server')}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-xl border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition disabled:opacity-50"
          >
            Accept Server Version
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={() => handleAction('keep_local')}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:bg-zinc-800 dark:hover:bg-white/90 transition disabled:opacity-50"
          >
            Keep My Version
          </button>
        </div>
      </div>
    </div>
  );
}
