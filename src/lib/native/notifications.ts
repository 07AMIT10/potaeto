import {
  isPermissionGranted as tauriIsPermissionGranted,
  requestPermission as tauriRequestPermission,
  sendNotification as tauriSendNotification,
} from '@tauri-apps/plugin-notification';
import { isTauri } from './platform';

export interface NotificationOptions {
  title: string;
  body: string;
  icon?: string;
}

/**
 * Checks whether native or Web notifications are supported.
 */
export function isNotificationSupported(): boolean {
  if (isTauri()) {
    return true;
  }
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Requests permission to show notifications. Returns true if granted.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      let granted = await tauriIsPermissionGranted();
      if (!granted) {
        const permission = await tauriRequestPermission();
        granted = permission === 'granted';
      }
      return granted;
    } catch {
      return false;
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      if (Notification.permission === 'granted') {
        return true;
      }
      if (Notification.permission === 'denied') {
        return false;
      }
      const permission = await Notification.requestPermission();
      return permission === 'granted';
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Sends a notification using Tauri's notification plugin if in Tauri,
 * otherwise Web Notification API if granted, or fallback.
 */
export async function sendNotification(options: NotificationOptions): Promise<void> {
  if (isTauri()) {
    try {
      let granted = await tauriIsPermissionGranted();
      if (!granted) {
        const permission = await tauriRequestPermission();
        granted = permission === 'granted';
      }
      if (granted) {
        tauriSendNotification({
          title: options.title,
          body: options.body,
          icon: options.icon,
        });
      }
      return;
    } catch {
      // Fall through to fallback if tauri notification plugin fails
    }
  }

  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      let permission = Notification.permission;
      if (permission === 'default') {
        permission = await Notification.requestPermission();
      }
      if (permission === 'granted') {
        new Notification(options.title, {
          body: options.body,
          icon: options.icon,
        });
        return;
      }
    } catch {
      // Fall through to fallback
    }
  }

  // Graceful fallback for non-supported or denied environments
  if (typeof console !== 'undefined' && console.info) {
    console.info(`[Notification] ${options.title}: ${options.body}`);
  }
}
