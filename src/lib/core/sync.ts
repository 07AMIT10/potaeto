/**
 * `SyncEngine`: flushes the outbox to the core and pulls the change log into
 * the local cache.
 *
 * `flush()` snapshots the outbox, pushes it in one idempotent batch, and
 * removes only the entries the server reports `applied`/`duplicate`
 * (conflicts and errors stay queued). It always calls `push` — even when the
 * outbox is empty — so a reconnect/hot-flush reconciles with the server in a
 * single code path (a no-op when there is nothing to send).
 *
 * `pull()` advances the local cursor and upserts message changes into the
 * `messages` cache (deletes become tombstones).
 */

import type { LocalDb } from './db';
import type { FlushResult, PushConflict, PushOperation, PushResult, SyncChange, SyncResponse } from './types';

export interface SyncClient {
  push(operations: PushOperation[]): Promise<PushResult[]>;
  sync(afterSeq: number): Promise<SyncResponse>;
}

export class SyncEngine {
  constructor(
    private readonly db: LocalDb,
    private readonly client: SyncClient,
  ) {}

  async flush(): Promise<FlushResult> {
    const entries = await this.db.outbox.toArray();
    let applied = 0;
    let failed = 0;
    const conflicts: PushConflict[] = [];

    try {
      const operations: PushOperation[] = entries.map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        entityType: entry.entityType,
        entityId: entry.entityId,
        baseRev: entry.baseRev,
        payload: entry.payload,
      }));
      const results = await this.client.push(operations);
      const byKey = new Map(results.map((result) => [result.idempotencyKey, result]));

      for (const entry of entries) {
        const result = byKey.get(entry.idempotencyKey);
        if (result && (result.status === 'applied' || result.status === 'duplicate')) {
          await this.db.outbox.delete(entry.idempotencyKey);
          applied += 1;
        } else {
          failed += 1;
          if (result && result.status === 'conflict') {
            conflicts.push({
              idempotencyKey: entry.idempotencyKey,
              entityType: entry.entityType,
              entityId: entry.entityId,
              baseRev: entry.baseRev,
              serverRev: result.rev,
              error: result.error,
              localPayload: entry.payload,
            });
          }
        }
      }
    } catch {
      // A network failure keeps every entry queued for the next flush.
      failed = entries.length;
    }

    return { applied, failed, conflicts };
  }

  async resolveConflict(idempotencyKey: string, action: 'keep_local' | 'accept_server'): Promise<void> {
    const entry = await this.db.outbox.get(idempotencyKey);
    if (!entry) return;

    if (action === 'accept_server') {
      await this.db.outbox.delete(idempotencyKey);
      await this.pull();
      return;
    }

    if (action === 'keep_local') {
      // Fetch latest server revision, re-align baseRev and re-queue
      const syncRes = await this.pull();
      let latestRev = entry.baseRev + 1;
      for (const change of syncRes.changes) {
        if (change.entityId === entry.entityId && typeof change.payload?.rev === 'number') {
          latestRev = Math.max(latestRev, change.payload.rev);
        }
      }
      await this.db.outbox.update(idempotencyKey, { baseRev: latestRev });
    }
  }

  async pull(): Promise<SyncResponse> {
    const cursor = await this.db.getCursor();
    const response = await this.client.sync(cursor);
    for (const change of response.changes) {
      if (change.entityType === 'message') {
        await this.applyMessageChange(change);
      }
    }
    await this.db.setCursor(response.nextSeq);
    return response;
  }

  private async applyMessageChange(change: SyncChange): Promise<void> {
    const payload = change.payload;
    const isDelete = change.operation === 'delete' || payload.deleted === 1;
    if (isDelete) {
      await this.db.messages.delete(change.entityId);
      return;
    }

    await this.db.messages.put({
      id: change.entityId,
      conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : '',
      role: payload.role === 'assistant' ? 'assistant' : 'user',
      content: typeof payload.content === 'string' ? payload.content : '',
      createdAt: typeof payload.created_at === 'string' ? payload.created_at : new Date().toISOString(),
    });
  }
}
