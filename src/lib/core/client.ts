/**
 * `CoreClient`: the PWA's typed HTTP client for the FastAPI core.
 *
 * Every request sends `credentials: 'include'` so the HttpOnly
 * `potaeto_device` cookie (set by `POST /v1/auth/pair`) authenticates the
 * device. In production the PWA and core are same-origin (Caddy proxies
 * `/v1/*`) and the base URL is empty, so requests are relative; in development
 * `NEXT_PUBLIC_CORE_URL` points at the core and the core's CORS middleware
 * allows the dev origin with credentials.
 */

import type {
  AgentEvent,
  CatalogModel,
  ChatStreamInput,
  ConversationInfo,
  ModelCatalog,
  PrimaryAgent,
  PushOperation,
  PushResult,
  PushStatus,
  SyncResponse,
} from './types';

export interface CoreClientOptions {
  baseUrl: string;
}

export class CoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}

// snake_case wire shapes (the FastAPI pydantic models).
interface WireSyncChange {
  seq: number;
  entity_type: string;
  entity_id: string;
  operation: string;
  payload: Record<string, unknown>;
  server_created_at: string;
}
interface WireSyncResponse {
  changes: WireSyncChange[];
  next_seq: number;
  has_more: boolean;
}
interface WirePushResult {
  idempotency_key: string;
  status: PushStatus;
  rev: number | null;
  seq: number | null;
  error: string | null;
}
interface WirePushResponse {
  results: WirePushResult[];
}
interface WireCatalogModel {
  provider: string;
  id: string;
  name: string;
  context_length: number | null;
  max_output_tokens: number | null;
  supports_tools: boolean;
  protocol: string;
  pricing: Record<string, unknown> | null;
  retention: string | null;
}
interface WireModelCatalog {
  models: WireCatalogModel[];
  active_model: string | null;
  active_provider: string | null;
}

export class CoreClient {
  private readonly baseUrl: string;

  constructor({ baseUrl }: CoreClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** The seeded primary agent (`e_potaeto`). Requires a paired device. */
  async getPrimaryAgent(): Promise<PrimaryAgent> {
    return this.requestJson<PrimaryAgent>('/v1/agent');
  }

  /** Ensure and return the (user, primary agent) conversation. */
  async getConversation(): Promise<ConversationInfo> {
    return this.requestJson<ConversationInfo>('/v1/chat/conversation');
  }

  /** Normalized provider catalog for the model picker (no keys). */
  async listModels(): Promise<ModelCatalog> {
    const wire = await this.requestJson<WireModelCatalog>('/v1/models');
    const models: CatalogModel[] = wire.models.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextLength: model.context_length,
      maxOutputTokens: model.max_output_tokens,
      supportsTools: model.supports_tools,
      protocol: model.protocol,
      pricing: model.pricing,
      retention: model.retention,
    }));
    return {
      models,
      activeModel: wire.active_model,
      activeProvider: wire.active_provider,
    };
  }

  /** Persist and activate the picker's model for future turns. */
  async setActiveModel(model: string, provider?: string): Promise<void> {
    await this.requestJson<unknown>('/v1/models/active', {
      method: 'POST',
      body: JSON.stringify({ model, provider: provider || undefined }),
    });
  }

  /** Pull the change log after the device cursor. */
  async sync(afterSeq = 0): Promise<SyncResponse> {
    const wire = await this.requestJson<WireSyncResponse>(`/v1/sync?after_seq=${afterSeq}`);
    return {
      changes: wire.changes.map((c) => ({
        seq: c.seq,
        entityType: c.entity_type,
        entityId: c.entity_id,
        operation: c.operation,
        payload: c.payload,
        serverCreatedAt: c.server_created_at,
      })),
      nextSeq: wire.next_seq,
      hasMore: wire.has_more,
    };
  }

  /** Push idempotent client writes; returns one result per operation. */
  async push(operations: PushOperation[]): Promise<PushResult[]> {
    const wire = await this.requestJson<WirePushResponse>('/v1/sync/push', {
      method: 'POST',
      body: JSON.stringify({
        operations: operations.map((op) => ({
          idempotency_key: op.idempotencyKey,
          entity_type: op.entityType,
          entity_id: op.entityId,
          base_rev: op.baseRev,
          payload: op.payload,
        })),
      }),
    });
    return wire.results.map((r) => ({
      idempotencyKey: r.idempotency_key,
      status: r.status,
      rev: r.rev,
      seq: r.seq,
      error: r.error,
    }));
  }

  /** Stream one turn as parsed SSE `AgentEvent`s. */
  async *chatStream(input: ChatStreamInput): AsyncIterable<AgentEvent> {
    const response = await fetch(`${this.baseUrl}/v1/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        conversation_id: input.conversationId,
        message: input.message,
        client_message_id: input.clientMessageId,
      }),
    });
    if (!response.ok) {
      throw new CoreError(`chat stream failed (${response.status})`, response.status);
    }
    if (!response.body) {
      throw new CoreError('chat stream returned no body', response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
        }
      }
      if (buffer.trim()) {
        const event = parseSseFrame(buffer);
        if (event) yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new CoreError(`${path} failed (${response.status})`, response.status);
    }
    return (await response.json()) as T;
  }
}

/** Parse one SSE frame (`event: <name>` + one or more `data:` lines). */
function parseSseFrame(frame: string): AgentEvent | null {
  let type = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;

  const text = dataLines.join('\n');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { type: type as AgentEvent['type'], data };
}
