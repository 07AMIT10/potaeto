'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCore } from '@/components/providers/CoreProvider';
import type { MemoryItem, MemoryStatus } from '@/lib/core/types';

type FilterTab = 'all' | MemoryStatus;

interface SupersedeState {
  memory: MemoryItem | null;
  newContent: string;
  submitting: boolean;
  error: string | null;
}

export function MemoryGovernance() {
  const { client, online } = useCore();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const [supersedeModal, setSupersedeModal] = useState<SupersedeState>({
    memory: null,
    newContent: '',
    submitting: false,
    error: null,
  });

  const loadMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statusFilter = activeTab === 'all' ? undefined : activeTab;
      const data = await client.getMemories(statusFilter);
      setMemories(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memories');
    } finally {
      setLoading(false);
    }
  }, [client, activeTab]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const handleRetract = async (id: string) => {
    if (!confirm('Are you sure you want to retract this memory? It will no longer influence agent turns.')) {
      return;
    }
    setActionLoadingId(id);
    try {
      await client.retractMemory(id);
      await loadMemories();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to retract memory');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleConfirm = async (id: string) => {
    setActionLoadingId(id);
    try {
      await client.confirmMemory(id);
      await loadMemories();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to confirm memory');
    } finally {
      setActionLoadingId(null);
    }
  };

  const openSupersede = (memory: MemoryItem) => {
    setSupersedeModal({
      memory,
      newContent: memory.content,
      submitting: false,
      error: null,
    });
  };

  const submitSupersede = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supersedeModal.memory) return;
    const trimmed = supersedeModal.newContent.trim();
    if (!trimmed) {
      setSupersedeModal((s) => ({ ...s, error: 'Content cannot be empty' }));
      return;
    }

    setSupersedeModal((s) => ({ ...s, submitting: true, error: null }));
    try {
      await client.supersedeMemory(supersedeModal.memory.id, trimmed);
      setSupersedeModal({ memory: null, newContent: '', submitting: false, error: null });
      await loadMemories();
    } catch (err) {
      setSupersedeModal((s) => ({
        ...s,
        submitting: false,
        error: err instanceof Error ? err.message : 'Failed to supersede memory',
      }));
    }
  };

  const filteredMemories = memories.filter((m) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      m.content.toLowerCase().includes(q) ||
      m.scope.toLowerCase().includes(q) ||
      (m.source && m.source.toLowerCase().includes(q)) ||
      m.kind.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      {/* Header controls & filter tabs */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-potato-100/50 dark:bg-potato-900/20 border border-[var(--card-border)]">
          {(['all', 'active', 'superseded', 'retracted'] as FilterTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all ${
                activeTab === tab
                  ? 'bg-potato-500 text-white shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <input
            type="text"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-field py-1.5 px-3 text-xs w-full sm:w-64"
          />
          <button
            type="button"
            onClick={loadMemories}
            disabled={loading}
            className="btn-ghost p-2 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            title="Refresh"
            aria-label="Refresh memories"
          >
            <svg
              className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Offline banner */}
      {!online && (
        <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-200">
          Device is currently offline. Showing cached memory state.
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-300">
          <p className="font-semibold">Error loading memories</p>
          <p className="mt-1 text-xs">{error}</p>
          <button
            type="button"
            onClick={loadMemories}
            className="mt-2 text-xs underline font-medium hover:text-red-900"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && memories.length === 0 && (
        <div className="py-12 flex flex-col items-center justify-center text-center">
          <div className="flex gap-1.5 mb-3">
            <span className="typing-dot" />
            <span className="typing-dot" style={{ animationDelay: '150ms' }} />
            <span className="typing-dot" style={{ animationDelay: '300ms' }} />
          </div>
          <p className="text-xs text-[var(--muted)]">Loading governed memories...</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && filteredMemories.length === 0 && (
        <div className="card p-8 text-center">
          <span className="text-3xl block mb-2" aria-hidden>
            🧠
          </span>
          <p className="text-sm font-semibold text-[var(--foreground)]">No memories found</p>
          <p className="text-xs text-[var(--muted)] mt-1">
            {searchQuery
              ? 'No memories match your search filter.'
              : activeTab === 'all'
                ? 'The agent has not stored any long-term memories yet.'
                : `No ${activeTab} memories recorded.`}
          </p>
        </div>
      )}

      {/* Memory list */}
      <div className="space-y-3">
        {filteredMemories.map((m) => {
          const isActing = actionLoadingId === m.id;
          return (
            <div
              key={m.id}
              className={`card p-4 transition-all ${
                m.status === 'retracted'
                  ? 'opacity-60 bg-black/5 dark:bg-white/5 border-dashed'
                  : m.status === 'superseded'
                    ? 'opacity-80'
                    : ''
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="space-y-2 flex-1 min-w-0">
                  {/* Badges */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    {/* Status Badge */}
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${
                        m.status === 'active'
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-800 dark:text-emerald-300'
                          : m.status === 'superseded'
                            ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
                            : 'bg-rose-100 dark:bg-rose-900/30 text-rose-800 dark:text-rose-300 line-through'
                      }`}
                    >
                      {m.status}
                    </span>

                    {/* Confirmation Status */}
                    {m.userConfirmed ? (
                      <span className="px-2 py-0.5 rounded-full font-medium bg-potato-100 dark:bg-potato-900/30 text-potato-800 dark:text-potato-300">
                        Confirmed
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300">
                        Candidate
                      </span>
                    )}

                    {/* Scope */}
                    <span className="px-2 py-0.5 rounded-full font-mono bg-black/5 dark:bg-white/10 text-[var(--muted)]">
                      {m.scope}
                    </span>

                    {/* Confidence */}
                    <span className="text-[var(--muted)]">
                      {Math.round(m.confidence * 100)}% conf
                    </span>

                    {/* Source */}
                    {m.source && (
                      <span className="text-[var(--muted)]">
                        src: {m.source}
                      </span>
                    )}
                  </div>

                  {/* Content body */}
                  <div className="text-sm font-medium text-[var(--foreground)] whitespace-pre-wrap break-words">
                    {m.content}
                  </div>

                  {/* Provenance and supersedes note */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                    <span>ID: <code className="font-mono text-[11px]">{m.id}</code></span>
                    {m.supersedes && (
                      <span>
                        supersedes: <code className="font-mono text-[11px]">{m.supersedes}</code>
                      </span>
                    )}
                    <span>{new Date(m.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex sm:flex-col items-center sm:items-end gap-2 shrink-0 pt-2 sm:pt-0">
                  {/* Confirm button for candidate facts */}
                  {!m.userConfirmed && m.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => handleConfirm(m.id)}
                      disabled={isActing}
                      className="btn-primary text-xs px-3 py-1.5"
                    >
                      {isActing ? 'Confirming...' : 'Confirm'}
                    </button>
                  )}

                  {/* Supersede button */}
                  {m.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => openSupersede(m)}
                      disabled={isActing}
                      className="btn-secondary text-xs px-3 py-1.5"
                    >
                      Supersede
                    </button>
                  )}

                  {/* Retract button */}
                  {m.status === 'active' && (
                    <button
                      type="button"
                      onClick={() => handleRetract(m.id)}
                      disabled={isActing}
                      className="text-xs px-3 py-1.5 rounded-xl text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-all font-medium"
                    >
                      {isActing ? 'Retracting...' : 'Retract'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Supersede Modal */}
      {supersedeModal.memory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="card max-w-lg w-full p-6 shadow-xl space-y-4">
            <div>
              <h3 className="text-lg font-bold text-[var(--foreground)]">Supersede Fact</h3>
              <p className="text-xs text-[var(--muted)] mt-1">
                The old fact will be marked <span className="font-semibold text-amber-600">superseded</span> and replaced with your updated content.
              </p>
            </div>

            <div className="rounded-xl p-3 bg-black/5 dark:bg-white/5 text-xs text-[var(--muted)]">
              <span className="font-semibold block mb-1">Previous Fact:</span>
              <p className="italic">{supersedeModal.memory.content}</p>
            </div>

            <form onSubmit={submitSupersede} className="space-y-4">
              <div>
                <label className="label text-xs">New Fact Content</label>
                <textarea
                  rows={4}
                  value={supersedeModal.newContent}
                  onChange={(e) =>
                    setSupersedeModal((s) => ({ ...s, newContent: e.target.value }))
                  }
                  placeholder="Enter the updated fact content..."
                  className="input-field py-2 text-sm resize-none"
                  autoFocus
                />
              </div>

              {supersedeModal.error && (
                <p className="text-xs text-rose-600 font-medium">{supersedeModal.error}</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() =>
                    setSupersedeModal({
                      memory: null,
                      newContent: '',
                      submitting: false,
                      error: null,
                    })
                  }
                  className="btn-secondary text-xs px-4 py-2"
                  disabled={supersedeModal.submitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={supersedeModal.submitting}
                  className="btn-primary text-xs px-4 py-2"
                >
                  {supersedeModal.submitting ? 'Superseding...' : 'Confirm Supersede'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
