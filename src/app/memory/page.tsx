'use client';

import Link from 'next/link';
import { CoreProvider, useCore } from '@/components/providers/CoreProvider';
import { MemoryGovernance } from '@/components/memory/MemoryGovernance';

function MemoryPageContent() {
  const { booted, online, agent } = useCore();

  if (!booted) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6">
        <div className="flex gap-1.5">
          <span className="typing-dot" />
          <span className="typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="typing-dot" style={{ animationDelay: '300ms' }} />
        </div>
      </main>
    );
  }

  if (!agent) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
        <span className="text-5xl mb-4" aria-hidden>
          🥔
        </span>
        <h1 className="text-2xl font-bold text-potato-600">
          {online ? 'Device not paired' : "You're offline"}
        </h1>
        <p className="mt-2 max-w-sm text-[var(--muted)]">
          {online
            ? 'Pair this device with Potaeto to view and govern long-term memories.'
            : 'Reconnect to inspect your agent memory store.'}
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Link href="/pair" className="btn-primary px-6 py-3">
            Pair this device
          </Link>
          <Link href="/" className="btn-secondary px-6 py-3">
            Back home
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col max-w-4xl mx-auto w-full px-4 py-6">
      {/* Top navigation */}
      <nav className="flex items-center justify-between pb-6 border-b border-[var(--card-border)] mb-6">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xl font-bold text-potato-600 hover:opacity-80 transition-opacity">
            Potaeto
          </Link>
          <span className="text-[var(--muted)]">/</span>
          <span className="text-sm font-semibold text-[var(--foreground)]">Memory Governance</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/chat" className="btn-secondary text-xs px-3 py-1.5">
            💬 Open Chat
          </Link>
        </div>
      </nav>

      {/* Hero header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--foreground)]">
          Governed Long-Term Memory
        </h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Review, confirm candidate facts, supersede outdated knowledge, and retract memories to prevent them from influencing future turns.
        </p>
      </div>

      {/* Main governance dashboard */}
      <MemoryGovernance />

      <footer className="mt-12 text-center py-6 text-xs text-[var(--muted)] border-t border-[var(--card-border)]">
        Potaeto Memory Governance &middot; Governed SQLite FTS5 store with provenance &amp; temporal validity
      </footer>
    </main>
  );
}

export default function MemoryPage() {
  return (
    <CoreProvider>
      <MemoryPageContent />
    </CoreProvider>
  );
}
