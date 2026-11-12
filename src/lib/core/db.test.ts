import { describe, expect, it } from 'vitest';
import { LocalDb } from './db';
import { ulid } from './ulid';

describe('LocalDb', () => {
  it('persists outbox entries, messages, and the sync cursor', async () => {
    const db = new LocalDb('db-test');
    try {
      await db.outbox.add({
        idempotencyKey: 'k1',
        entityType: 'message',
        entityId: 'm1',
        baseRev: 0,
        payload: { content: 'hi' },
      });
      expect(await db.outbox.count()).toBe(1);

      await db.messages.put({
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'hi',
        createdAt: '2026-01-01T00:00:00Z',
      });
      expect(await db.messages.count()).toBe(1);

      expect(await db.getCursor()).toBe(0);
      await db.setCursor(7);
      expect(await db.getCursor()).toBe(7);
    } finally {
      await db.delete();
    }
  });
});

describe('ulid', () => {
  it('produces 26-character, unique, Crockford base32 ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });
});
