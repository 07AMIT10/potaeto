import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as notifPlugin from '@tauri-apps/plugin-notification';
import {
  isNotificationSupported,
  requestNotificationPermission,
  sendNotification,
} from './notifications';

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

describe('notifications bridge', () => {
  let mockNotificationConstructor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    delete (window as unknown as Record<string, unknown>).__TAURI__;

    mockNotificationConstructor = vi.fn();
    (mockNotificationConstructor as unknown as Record<string, unknown>).permission = 'default';
    (mockNotificationConstructor as unknown as Record<string, unknown>).requestPermission = vi
      .fn()
      .mockResolvedValue('granted');

    vi.stubGlobal('Notification', mockNotificationConstructor);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('isNotificationSupported', () => {
    it('returns true when running in Tauri', () => {
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      // Even if Notification is not in window
      delete (window as unknown as Record<string, unknown>).Notification;
      expect(isNotificationSupported()).toBe(true);
    });

    it('returns true when Web Notification is available', () => {
      expect(isNotificationSupported()).toBe(true);
    });

    it('returns false when neither Tauri nor Notification is available', () => {
      delete (window as unknown as Record<string, unknown>).Notification;
      expect(isNotificationSupported()).toBe(false);
    });
  });

  describe('requestNotificationPermission', () => {
    describe('in Tauri', () => {
      beforeEach(() => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      });

      it('returns true if permission is already granted', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(true);

        const result = await requestNotificationPermission();
        expect(result).toBe(true);
        expect(notifPlugin.requestPermission).not.toHaveBeenCalled();
      });

      it('requests permission if not already granted and returns true when granted', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(false);
        vi.spyOn(notifPlugin, 'requestPermission').mockResolvedValue('granted');

        const result = await requestNotificationPermission();
        expect(result).toBe(true);
        expect(notifPlugin.requestPermission).toHaveBeenCalled();
      });

      it('returns false if permission is denied', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(false);
        vi.spyOn(notifPlugin, 'requestPermission').mockResolvedValue('denied');

        const result = await requestNotificationPermission();
        expect(result).toBe(false);
      });

      it('returns false if plugin throws an error', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockRejectedValue(new Error('plugin error'));

        const result = await requestNotificationPermission();
        expect(result).toBe(false);
      });
    });

    describe('in Web', () => {
      it('returns true immediately if Notification.permission is granted', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'granted';

        const result = await requestNotificationPermission();
        expect(result).toBe(true);
        expect(Notification.requestPermission).not.toHaveBeenCalled();
      });

      it('returns false immediately if Notification.permission is denied', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'denied';

        const result = await requestNotificationPermission();
        expect(result).toBe(false);
        expect(Notification.requestPermission).not.toHaveBeenCalled();
      });

      it('prompts user and returns true if granted', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'default';
        (Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('granted');

        const result = await requestNotificationPermission();
        expect(result).toBe(true);
        expect(Notification.requestPermission).toHaveBeenCalled();
      });

      it('prompts user and returns false if denied', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'default';
        (Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('denied');

        const result = await requestNotificationPermission();
        expect(result).toBe(false);
      });

      it('returns false if Notification is not defined', async () => {
        delete (window as unknown as Record<string, unknown>).Notification;

        const result = await requestNotificationPermission();
        expect(result).toBe(false);
      });
    });
  });

  describe('sendNotification', () => {
    describe('in Tauri', () => {
      beforeEach(() => {
        (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
      });

      it('sends notification via Tauri plugin when permission is granted', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(true);
        const sendSpy = vi.spyOn(notifPlugin, 'sendNotification');

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
          icon: 'icon.png',
        });

        expect(sendSpy).toHaveBeenCalledWith({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
          icon: 'icon.png',
        });
      });

      it('requests permission and sends notification if granted', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(false);
        vi.spyOn(notifPlugin, 'requestPermission').mockResolvedValue('granted');
        const sendSpy = vi.spyOn(notifPlugin, 'sendNotification');

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
        });

        expect(sendSpy).toHaveBeenCalledWith({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
          icon: undefined,
        });
      });

      it('does not send notification if permission is denied', async () => {
        vi.spyOn(notifPlugin, 'isPermissionGranted').mockResolvedValue(false);
        vi.spyOn(notifPlugin, 'requestPermission').mockResolvedValue('denied');
        const sendSpy = vi.spyOn(notifPlugin, 'sendNotification');

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
        });

        expect(sendSpy).not.toHaveBeenCalled();
      });
    });

    describe('in Web', () => {
      it('creates Web Notification when permission is granted', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'granted';

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
          icon: '/test-icon.png',
        });

        expect(mockNotificationConstructor).toHaveBeenCalledWith('Approval Required', {
          body: 'A tool call requires your approval.',
          icon: '/test-icon.png',
        });
      });

      it('requests permission and creates notification when permission is default', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'default';
        (Notification.requestPermission as ReturnType<typeof vi.fn>).mockResolvedValue('granted');

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
        });

        expect(Notification.requestPermission).toHaveBeenCalled();
        expect(mockNotificationConstructor).toHaveBeenCalledWith('Approval Required', {
          body: 'A tool call requires your approval.',
          icon: undefined,
        });
      });

      it('does not create notification when permission is denied', async () => {
        (Notification as unknown as Record<string, unknown>).permission = 'denied';

        await sendNotification({
          title: 'Approval Required',
          body: 'A tool call requires your approval.',
        });

        expect(mockNotificationConstructor).not.toHaveBeenCalled();
      });
    });

    describe('graceful fallback', () => {
      it('does not throw when neither Tauri nor Notification is available', async () => {
        delete (window as unknown as Record<string, unknown>).Notification;
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

        await expect(
          sendNotification({
            title: 'Fallback Test',
            body: 'Should log gracefully',
          })
        ).resolves.not.toThrow();

        expect(infoSpy).toHaveBeenCalledWith('[Notification] Fallback Test: Should log gracefully');
      });
    });
  });
});
