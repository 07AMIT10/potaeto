/**
 * Storage Persistence API & Quota Tracking
 *
 * Provides utilities to inspect and request persistent storage via
 * `navigator.storage.persist()` and track quota usage via `navigator.storage.estimate()`.
 */

export interface StorageQuotaInfo {
  usage: number;
  quota: number;
  percentUsed: number;
  formattedUsage: string;
  formattedQuota: string;
}

/**
 * Formats a byte count into a human-readable string (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  const formatted = Math.round(val * 10) / 10;
  return `${formatted} ${units[i]}`;
}

/**
 * Checks if the origin currently has persistent storage granted.
 * Returns false if navigator.storage.persisted is not supported.
 */
export async function checkStoragePersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
    return false;
  }
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Requests persistent storage for the current origin.
 * Returns false if navigator.storage.persist is not supported or was rejected.
 */
export async function requestStoragePersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Obtains the current storage estimate (usage and quota) and calculates
 * formatted strings and usage percentage.
 */
export async function getStorageQuota(): Promise<StorageQuotaInfo> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
    return {
      usage: 0,
      quota: 0,
      percentUsed: 0,
      formattedUsage: '0 B',
      formattedQuota: '0 B',
    };
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    const percentUsed = quota > 0 ? Math.round((usage / quota) * 1000) / 10 : 0;
    return {
      usage,
      quota,
      percentUsed,
      formattedUsage: formatBytes(usage),
      formattedQuota: formatBytes(quota),
    };
  } catch {
    return {
      usage: 0,
      quota: 0,
      percentUsed: 0,
      formattedUsage: '0 B',
      formattedQuota: '0 B',
    };
  }
}
