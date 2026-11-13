import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as openerPlugin from '@tauri-apps/plugin-opener';
import { isTauri, getPlatform, openExternalUrl } from './platform';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}));

describe('platform bridge', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (window as unknown as Record<string, unknown>).__TAURI__;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  describe('isTauri', () => {
    it('returns false in standard browser window', () => {
      expect(isTauri()).toBe(false);
    });

    it('returns true when __TAURI_INTERNALS__ is present', () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      expect(isTauri()).toBe(true);
    });

    it('returns true when __TAURI__ is present', () => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {};
      expect(isTauri()).toBe(true);
    });
  });

  describe('getPlatform', () => {
    it('returns "web" when not running in Tauri', () => {
      expect(getPlatform()).toBe('web');
    });

    it('returns "desktop" when running in Tauri on desktop', () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        configurable: true,
      });
      expect(getPlatform()).toBe('desktop');
    });

    it('returns "mobile" when running in Tauri on Android', () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
        configurable: true,
      });
      expect(getPlatform()).toBe('mobile');
    });

    it('returns "mobile" when running in Tauri on iOS (iPhone)', () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
      });
      expect(getPlatform()).toBe('mobile');
    });
  });

  describe('openExternalUrl', () => {
    it('opens url using plugin-opener when in Tauri', async () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      const openMock = vi.spyOn(openerPlugin, 'openUrl').mockResolvedValue();

      await openExternalUrl('https://example.com');
      expect(openMock).toHaveBeenCalledWith('https://example.com');
    });

    it('falls back to window.open when openUrl fails in Tauri', async () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      vi.spyOn(openerPlugin, 'openUrl').mockRejectedValue(new Error('IPC failed'));
      const windowOpenMock = vi.fn();
      vi.stubGlobal('open', windowOpenMock);

      await openExternalUrl('https://example.com');
      expect(windowOpenMock).toHaveBeenCalledWith('https://example.com', '_blank');
    });

    it('falls back to window.open when not in Tauri', async () => {
      const windowOpenMock = vi.fn();
      vi.stubGlobal('open', windowOpenMock);

      await openExternalUrl('https://example.com');
      expect(windowOpenMock).toHaveBeenCalledWith('https://example.com', '_blank');
    });
  });
});
