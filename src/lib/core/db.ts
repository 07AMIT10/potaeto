/**
 * Local PWA cache: a Dexie/IndexedDB database with three tables.
 *
 * - `messages` — the cached copy of a conversation's messages, for offline
 *   history (upserted from the sync change log or the live stream).
 * - `outbox` — client writes that have not yet been applied server-side,
 *   keyed by idempotency key so a retried flush never duplicates a message.
 * - `meta` — small key/value store; holds the sync pull cursor.
 *
 * The repository interface is driver-based: callers depend on `LocalDb`
 * through `SyncEngine`/`CoreProvider`, so sqlite-wasm/OPFS can replace Dexie
 * in Release 3 without changing them.
 */

import Dexie, { type Table } from 'dexie';
import type { MessageRole, PrimaryAgent } from './types';

export interface OutboxEntry {
  idempotencyKey: string;
  entityType: string;
  entityId: string;
  baseRev: number;
  payload: Record<string, unknown>;
  createdAt?: string;
}

export interface CachedMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface MetaEntry {
  key: string;
  value: string;
}

const SYNC_CURSOR_KEY = 'sync_cursor';
const AGENT_KEY = 'agent';
const CONVERSATION_ID_KEY = 'conversation_id';

export class LocalDb extends Dexie {
  messages!: Table<CachedMessage, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<MetaEntry, string>;

  constructor(name = 'potaeto') {
    super(name);
    this.version(1).stores({
      messages: 'id, conversationId, createdAt',
      outbox: 'idempotencyKey, createdAt',
      meta: 'key',
    });
  }

  /** The next sync `seq` this device has not yet pulled (0 = full pull). */
  async getCursor(): Promise<number> {
    const row = await this.meta.get(SYNC_CURSOR_KEY);
    if (!row) return 0;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  async setCursor(seq: number): Promise<void> {
    await this.meta.put({ key: SYNC_CURSOR_KEY, value: String(seq) });
  }

  /** Persist the primary agent so an offline reload can still render it. */
  async saveAgent(agent: PrimaryAgent): Promise<void> {
    await this.meta.put({ key: AGENT_KEY, value: JSON.stringify(agent) });
  }

  async getAgent(): Promise<PrimaryAgent | null> {
    const row = await this.meta.get(AGENT_KEY);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as PrimaryAgent;
    } catch {
      return null;
    }
  }

  /** Persist the resolved conversation id for offline history hydration. */
  async saveConversationId(id: string): Promise<void> {
    await this.meta.put({ key: CONVERSATION_ID_KEY, value: id });
  }

  async getConversationId(): Promise<string | null> {
    const row = await this.meta.get(CONVERSATION_ID_KEY);
    return row ? row.value : null;
  }
}
