'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CoreProvider, useCore } from '@/components/providers/CoreProvider';
import { ChatUI } from '@/app/(app)/chat/[entityId]/ChatUI';

type StorageStatus = 'checking' | 'granted' | 'denied' | 'unsupported';

/**
 * Ask the browser to keep IndexedDB out of eviction and surface the answer.
 * A denied request is not fatal — sync/backup is still the source of truth —
 * but the user should know the offline cache is best-effort.
 */
function usePersistentStorage(): StorageStatus {
  const [status, setStatus] = useState<StorageStatus>(() =>
    typeof navigator === 'undefined' || !navigator.storage?.persist
      ? 'unsupported'
      : 'checking',
  );
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
    let cancelled = false;
    (async () => {
      try {
        const already = await navigator.storage.persisted();
        const granted = already || (await navigator.storage.persist());
        if (!cancelled) setStatus(granted ? 'granted' : 'denied');
      } catch {
        if (!cancelled) setStatus('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return status;
}

function StorageStatusBadge({ status }: { status: StorageStatus }) {
  if (status === 'checking' || status === 'unsupported') return null;
  return (
    <p className="text-xs text-[var(--muted)] text-center" data-testid="storage-status">
      Offline storage:{' '}
      {status === 'granted'
        ? 'persistent'
        : 'best-effort (the browser may evict the cache)'}
    </p>
  );
}

function ChatPageContent() {
  const { agent, conversationId, online, booted } = useCore();
  const storageStatus = usePersistentStorage();

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

  if (!agent || !conversationId) {
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
            ? 'Pair this device with Potaeto to start chatting.'
            : 'Reconnect to load your conversation with Potaeto.'}
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Link href="/pair" className="btn-primary px-6 py-3">
            Pair this device
          </Link>
          <Link href="/" className="btn-secondary px-6 py-3">
            Back home
          </Link>
        </div>
        <div className="mt-6">
          <StorageStatusBadge status={storageStatus} />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex flex-col max-w-3xl mx-auto w-full px-4 py-6">
      {!online && (
        <div className="mb-3 rounded-lg bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 px-4 py-2 text-sm text-center">
          You&apos;re offline — messages will sync when you reconnect.
        </div>
      )}
      <div className="mb-2">
        <StorageStatusBadge status={storageStatus} />
      </div>
      <ChatUI entityId={agent.id} entityName={agent.name} avatarTemplate="potato" />
    </main>
  );
}

export default function ChatPage() {
  return (
    <CoreProvider>
      <ChatPageContent />
    </CoreProvider>
  );
}
