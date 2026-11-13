'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  checkStoragePersistence,
  getStorageQuota,
  requestStoragePersistence,
  type StorageQuotaInfo,
} from '@/lib/storage/persistence';

export function StorageStatus() {
  const [loading, setLoading] = useState(true);
  const [isPersisted, setIsPersisted] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [quota, setQuota] = useState<StorageQuotaInfo>({
    usage: 0,
    quota: 0,
    percentUsed: 0,
    formattedUsage: '0 B',
    formattedQuota: '0 B',
  });

  const refresh = useCallback(async () => {
    try {
      const [persisted, quotaInfo] = await Promise.all([
        checkStoragePersistence(),
        getStorageQuota(),
      ]);
      setIsPersisted(persisted);
      setQuota(quotaInfo);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRequestPersistence = async () => {
    setRequesting(true);
    try {
      const granted = await requestStoragePersistence();
      setIsPersisted(granted);
      const quotaInfo = await getStorageQuota();
      setQuota(quotaInfo);
    } finally {
      setRequesting(false);
    }
  };

  const clampedPercent = Math.min(Math.max(quota.percentUsed, 0), 100);

  return (
    <div className="space-y-4 text-sm">
      {/* Header with Title and Persistence Status Badge */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-[var(--foreground)]">Persistence Status</span>
        {loading ? (
          <span className="text-xs text-[var(--muted)]">Checking…</span>
        ) : isPersisted ? (
          <span
            data-testid="persistence-badge"
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            Persistent Storage
          </span>
        ) : (
          <span
            data-testid="persistence-badge"
            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
            Best-effort Storage
          </span>
        )}
      </div>

      {/* Visual Storage Gauge */}
      <div className="space-y-1.5">
        <div className="flex justify-between items-center text-xs text-[var(--muted)]">
          <span>Used: <strong className="text-[var(--foreground)] font-medium">{quota.formattedUsage}</strong></span>
          <span>Quota: <strong className="text-[var(--foreground)] font-medium">{quota.formattedQuota}</strong></span>
        </div>

        <div
          role="progressbar"
          aria-valuenow={quota.percentUsed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Storage quota usage"
          className="w-full bg-slate-200 dark:bg-zinc-800 rounded-full h-2.5 overflow-hidden"
        >
          <div
            className="bg-potato-500 h-full rounded-full transition-all duration-300"
            style={{ width: `${clampedPercent}%` }}
          />
        </div>

        <div className="flex justify-between items-center text-[11px] text-[var(--muted)]">
          <span>Local cache & offline store</span>
          <span>{quota.percentUsed}% used</span>
        </div>
      </div>

      {/* Persistence Action or Info */}
      {!loading && (
        <div className="pt-1">
          {isPersisted ? (
            <p className="text-xs text-[var(--muted)]">
              Your offline messages and outbox are protected from automatic browser eviction under storage pressure.
            </p>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={handleRequestPersistence}
                disabled={requesting}
                className="btn-secondary w-full text-xs py-2"
              >
                {requesting ? 'Requesting…' : 'Request Persistence'}
              </button>
              <p className="text-[11px] text-[var(--muted)] text-center">
                Prevents browser eviction of cached conversations and unsynced outbox queue.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
