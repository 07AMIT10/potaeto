/**
 * Shared wire/domain types for the PWA core client, the IndexedDB cache, and
 * the sync outbox.
 *
 * Client-side shapes use camelCase; `CoreClient` converts to the snake_case
 * wire shapes emitted by the FastAPI core (see `apps/orchestrator/app/api/`).
 */

export type AgentEventType = 'token' | 'tool_call' | 'tool_result' | 'done' | 'error';

export interface AgentEvent {
  type: AgentEventType;
  data: Record<string, unknown>;
}

export interface ChatStreamInput {
  conversationId: string;
  message: string;
  /** Client-generated ULID used as the server-side message id (dedupe). */
  clientMessageId?: string;
}

export type PushStatus = 'applied' | 'duplicate' | 'conflict' | 'unsupported' | 'error';

export interface PushOperation {
  idempotencyKey: string;
  entityType: string;
  entityId: string;
  baseRev: number;
  payload: Record<string, unknown>;
}

export interface PushResult {
  idempotencyKey: string;
  status: PushStatus;
  rev: number | null;
  seq: number | null;
  error: string | null;
}

export interface SyncChange {
  seq: number;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Record<string, unknown>;
  serverCreatedAt: string;
}

export interface SyncResponse {
  changes: SyncChange[];
  nextSeq: number;
  hasMore: boolean;
}

export interface FlushResult {
  applied: number;
  failed: number;
}

export interface PrimaryAgent {
  id: string;
  name: string;
  slug: string;
  avatar: string | null;
}

export interface ConversationInfo {
  id: string;
  entityId: string;
}

/** One normalized catalog entry (never contains an API key). */
export interface CatalogModel {
  provider: string;
  id: string;
  name: string;
  contextLength: number | null;
  maxOutputTokens: number | null;
  supportsTools: boolean;
  protocol: string;
  pricing: Record<string, unknown> | null;
  retention: string | null;
}

export interface ModelCatalog {
  models: CatalogModel[];
  activeModel: string | null;
  activeProvider: string | null;
}

export type MessageRole = 'user' | 'assistant';
