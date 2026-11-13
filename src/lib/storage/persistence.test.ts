import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkStoragePersistence,
  formatBytes,
  getStorageQuota,
  requestStoragePersistence,
} from './persistence';

describe('Storage Persistence API', () => {
  describe('formatBytes', () => {
    it('handles zero, negative, or invalid byte values', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(-100)).toBe('0 B');
      expect(formatBytes(Number.NaN)).toBe('0 B');
      expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
    });

    it('formats bytes, kilobytes, megabytes, gigabytes, and terabytes accurately', () => {
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
      expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
    });
  });

  describe('checkStoragePersistence', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns false if navigator.storage or persisted() is unavailable', async () => {
      vi.stubGlobal('navigator', {});
      expect(await checkStoragePersistence()).toBe(false);

      vi.stubGlobal('navigator', { storage: {} });
      expect(await checkStoragePersistence()).toBe(false);
    });

    it('returns true when persisted() resolves to true', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          persisted: vi.fn().mockResolvedValue(true),
        },
      });
      expect(await checkStoragePersistence()).toBe(true);
    });

    it('returns false when persisted() resolves to false', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          persisted: vi.fn().mockResolvedValue(false),
        },
      });
      expect(await checkStoragePersistence()).toBe(false);
    });

    it('catches and returns false if persisted() throws', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          persisted: vi.fn().mockRejectedValue(new Error('Security error')),
        },
      });
      expect(await checkStoragePersistence()).toBe(false);
    });
  });

  describe('requestStoragePersistence', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns false if navigator.storage or persist() is unavailable', async () => {
      vi.stubGlobal('navigator', {});
      expect(await requestStoragePersistence()).toBe(false);

      vi.stubGlobal('navigator', { storage: {} });
      expect(await requestStoragePersistence()).toBe(false);
    });

    it('calls navigator.storage.persist() and returns granted boolean', async () => {
      const persistMock = vi.fn().mockResolvedValue(true);
      vi.stubGlobal('navigator', {
        storage: {
          persist: persistMock,
        },
      });

      const granted = await requestStoragePersistence();
      expect(persistMock).toHaveBeenCalledTimes(1);
      expect(granted).toBe(true);
    });

    it('returns false when navigator.storage.persist() resolves to false', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          persist: vi.fn().mockResolvedValue(false),
        },
      });
      expect(await requestStoragePersistence()).toBe(false);
    });

    it('catches and returns false if persist() throws', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          persist: vi.fn().mockRejectedValue(new Error('Permission denied')),
        },
      });
      expect(await requestStoragePersistence()).toBe(false);
    });
  });

  describe('getStorageQuota', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns zeroes if navigator.storage.estimate is unavailable', async () => {
      vi.stubGlobal('navigator', {});
      const quota = await getStorageQuota();
      expect(quota).toEqual({
        usage: 0,
        quota: 0,
        percentUsed: 0,
        formattedUsage: '0 B',
        formattedQuota: '0 B',
      });
    });

    it('returns calculated usage and quota metrics when estimate succeeds', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn().mockResolvedValue({
            usage: 250 * 1024 * 1024, // 250 MB
            quota: 1000 * 1024 * 1024, // 1000 MB
          }),
        },
      });

      const quota = await getStorageQuota();
      expect(quota.usage).toBe(250 * 1024 * 1024);
      expect(quota.quota).toBe(1000 * 1024 * 1024);
      expect(quota.percentUsed).toBe(25);
      expect(quota.formattedUsage).toBe('250 MB');
      expect(quota.formattedQuota).toBe('1000 MB');
    });

    it('handles zero quota without dividing by zero', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn().mockResolvedValue({
            usage: 0,
            quota: 0,
          }),
        },
      });

      const quota = await getStorageQuota();
      expect(quota.percentUsed).toBe(0);
      expect(quota.formattedUsage).toBe('0 B');
      expect(quota.formattedQuota).toBe('0 B');
    });

    it('handles estimate() throwing by returning defaults', async () => {
      vi.stubGlobal('navigator', {
        storage: {
          estimate: vi.fn().mockRejectedValue(new Error('Disk failure')),
        },
      });

      const quota = await getStorageQuota();
      expect(quota).toEqual({
        usage: 0,
        quota: 0,
        percentUsed: 0,
        formattedUsage: '0 B',
        formattedQuota: '0 B',
      });
    });
  });
});
