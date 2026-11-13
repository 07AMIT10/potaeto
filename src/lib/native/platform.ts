import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Checks whether the current runtime environment is Tauri.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

/**
 * Returns the active platform: 'desktop', 'mobile', or 'web'.
 */
export function getPlatform(): 'desktop' | 'mobile' | 'web' {
  if (!isTauri()) {
    return 'web';
  }
  if (typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * Opens an external URL using Tauri opener plugin if in Tauri, falling back to window.open.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await openUrl(url);
      return;
    } catch {
      // Fallback below if plugin invocation fails
    }
  }

  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank');
  }
}
