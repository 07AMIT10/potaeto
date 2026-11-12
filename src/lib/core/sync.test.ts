import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { LocalDb } from './db';
import { SyncEngine } from './sync';

// Reset the shared 'test' database before each test so the verbatim brief
// cases remain isolated (fake-indexeddb is in-memory per process).
beforeEach(async () => {
  await Dexie.delete('test');
});

describe('SyncEngine', () => {
  it('queues offline messages and flushes idempotently', async () => {
    const db = new LocalDb('test');
    const client = { push: vi.fn().mockResolvedValue([{ idempotencyKey: 'k1', status: 'applied', seq: 7 }]) };
    const sync = new SyncEngine(db, client as any);
    await db.outbox.add({ idempotencyKey: 'k1', entityType: 'message', entityId: 'm1', baseRev: 0, payload: {} });
    await sync.flush();
    await sync.flush();
    expect(client.push).toHaveBeenCalledTimes(2);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the outbox on a network failure', async () => {
    const db = new LocalDb('test');
    const client = { push: vi.fn().mockRejectedValue(new Error('offline')) };
    const sync = new SyncEngine(db, client as any);
    await db.outbox.add({ idempotencyKey: 'k1', entityType: 'message', entityId: 'm1', baseRev: 0, payload: {} });
    await expect(sync.flush()).resolves.toMatchObject({ failed: 1 });
    expect(await db.outbox.count()).toBe(1);
  });

  it('clears only applied and duplicate entries', async () => {
    const db = new LocalDb('test');
    const client = {
      push: vi.fn().mockResolvedValue([
        { idempotencyKey: 'k1', status: 'applied', seq: 1 },
        { idempotencyKey: 'k2', status: 'duplicate', seq: 1 },
        { idempotencyKey: 'k3', status: 'conflict', rev: 3, error: 'stale_rev' },
      ]),
    };
    const sync = new SyncEngine(db, client as any);
    await db.outbox.bulkAdd([
      { idempotencyKey: 'k1', entityType: 'message', entityId: 'm1', baseRev: 0, payload: {} },
      { idempotencyKey: 'k2', entityType: 'message', entityId: 'm2', baseRev: 0, payload: {} },
      { idempotencyKey: 'k3', entityType: 'entity', entityId: 'e1', baseRev: 0, payload: {} },
    ]);
    const result = await sync.flush();
    expect(result).toEqual({ applied: 2, failed: 1 });
    expect(await db.outbox.count()).toBe(1);
    expect(await db.outbox.get('k3')).toBeDefined();
  });

  it('applies message changes and advances the cursor on pull', async () => {
    const db = new LocalDb('test');
    const client = {
      push: vi.fn(),
      sync: vi.fn().mockResolvedValue({
        changes: [
          {
            seq: 5,
            entityType: 'message',
            entityId: 'm1',
            operation: 'insert',
            payload: { role: 'user', content: 'hi', conversation_id: 'c1', created_at: '2026-01-01T00:00:00Z' },
            serverCreatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        nextSeq: 5,
        hasMore: false,
      }),
    };
    const sync = new SyncEngine(db, client as any);
    await sync.pull();
    expect(await db.getCursor()).toBe(5);
    expect(await db.messages.get('m1')).toMatchObject({
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      content: 'hi',
    });
  });
});
