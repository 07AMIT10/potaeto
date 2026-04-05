'use client';

import type { GuestChatMessage } from '@/lib/guestStorage';

const PREFIX = 'potaeto_public_try_chat_';

function safeParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function loadPublicTryChat(entityId: string): GuestChatMessage[] {
  if (typeof window === 'undefined') return [];
  return safeParse<GuestChatMessage[]>(window.localStorage.getItem(`${PREFIX}${entityId}`), []);
}

export function savePublicTryChat(entityId: string, messages: GuestChatMessage[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(`${PREFIX}${entityId}`, JSON.stringify(messages));
}
