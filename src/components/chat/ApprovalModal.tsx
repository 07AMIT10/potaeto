'use client';

import { useEffect, useState } from 'react';

export interface ApprovalModalProps {
  approval: {
    id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    expires_at?: number;
  };
  onResolve: (decision: 'approved' | 'rejected') => Promise<void> | void;
  loading?: boolean;
}

export function ApprovalModal({ approval, onResolve, loading: externalLoading = false }: ApprovalModalProps) {
  const [internalLoading, setInternalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isResolving = externalLoading || internalLoading;

  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(() => {
    if (!approval.expires_at) return null;
    const nowSec = Date.now() / 1000;
    return Math.max(0, Math.floor(approval.expires_at - nowSec));
  });

  useEffect(() => {
    if (!approval.expires_at) return;
    const updateCountdown = () => {
      const nowSec = Date.now() / 1000;
      const rem = Math.max(0, Math.floor(approval.expires_at! - nowSec));
      setSecondsRemaining(rem);
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [approval.expires_at]);

  const handleDecision = async (decision: 'approved' | 'rejected') => {
    if (isResolving) return;
    setError(null);
    setInternalLoading(true);
    try {
      await onResolve(decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resolve approval');
      setInternalLoading(false);
    }
  };

  const formattedArgs = JSON.stringify(approval.arguments ?? {}, null, 2);
  const isExpired = secondsRemaining !== null && secondsRemaining <= 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
    >
      <div className="relative w-full max-w-lg rounded-2xl bg-[var(--card)] border border-[var(--card-border)] p-6 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-3 w-3 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
            </span>
            <h2 id="approval-modal-title" className="text-lg font-bold text-[var(--foreground)]">
              Action Approval Required
            </h2>
          </div>
          {secondsRemaining !== null && (
            <span
              className={`text-xs font-mono px-2 py-1 rounded-md border ${
                isExpired
                  ? 'bg-red-500/10 border-red-500/30 text-red-500'
                  : 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400'
              }`}
            >
              {isExpired ? 'Expired' : `Expires in ${secondsRemaining}s`}
            </span>
          )}
        </div>

        {/* Warning Banner */}
        <div className="flex items-center gap-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-sm text-amber-700 dark:text-amber-300">
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <span className="font-medium">
            This action requires your confirmation before proceeding.
          </span>
        </div>

        {/* Tool Info */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <span>Tool:</span>
            <span className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono font-medium text-[var(--foreground)]">
              {approval.tool_name}
            </span>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-[var(--muted)]">Arguments:</span>
            <pre className="max-h-56 overflow-x-auto overflow-y-auto rounded-xl bg-black/5 dark:bg-black/40 border border-[var(--card-border)] p-3 text-xs font-mono text-[var(--foreground)] scrollbar-thin">
              <code>{formattedArgs}</code>
            </pre>
          </div>
        </div>

        {/* Error message if resolution failed */}
        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={() => handleDecision('rejected')}
            disabled={isResolving || isExpired}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-700 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
          >
            {isResolving ? 'Rejecting...' : 'Reject'}
          </button>
          <button
            type="button"
            onClick={() => handleDecision('approved')}
            disabled={isResolving || isExpired}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-emerald-700 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none"
          >
            {isResolving ? 'Approving...' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
