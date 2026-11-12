'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker. A separate client component because the root
 * layout is a server component. Registration is best-effort: it never blocks
 * first paint and is a no-op when service workers are unsupported (e.g. plain
 * HTTP on a non-localhost host).
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Ignore registration failures (offline, unsupported context).
    });
  }, []);

  return null;
}
