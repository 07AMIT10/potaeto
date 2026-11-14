/**
 * Shared wire/domain types for the PWA core client, the IndexedDB cache, and
 * the sync outbox.
 *
 * Client-side shapes use camelCase; `CoreClient` converts to the snake_case
 * wire shapes emitted by the FastAPI core (see `apps/orchestrator/app/api/`).
 */

export type AgentEventType = 'token' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'approval_required' | 'tool_approval_required';

export interface AgentEvent {
  type: AgentEventType;
  data: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'token'; data: { text: string } }
  | { type: 'tool_call'; data: { tool_name: string; arguments: Record<string, unknown> } }
  | { type: 'tool_result'; data: { tool_name: string; result: unknown } }
  | { type: 'approval_required'; data: { approval_id: string; tool_name: string; arguments: Record<string, unknown> } }
  | { type: 'done'; data: { message_id?: string; [key: string]: unknown } }
  | { type: 'error'; data: { message?: string; code?: string; [key: string]: unknown } };

export interface ApprovalRequest {
  id: string;
  action_hash: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expires_at: number;
  created_at: number;
  requested_by?: string;
  resolved_by?: string | null;
  resolved_at?: number | null;
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

export interface PushConflict {
  idempotencyKey: string;
  entityType: string;
  entityId: string;
  baseRev: number;
  serverRev: number | null;
  error: string | null;
  localPayload: Record<string, unknown>;
}

export interface FlushResult {
  applied: number;
  failed: number;
  conflicts: PushConflict[];
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

export interface ProviderStat {
  tokens_in: number;
  tokens_out: number;
  cost: number;
  call_count: number;
}

export interface ModelStat {
  tokens_in: number;
  tokens_out: number;
  cost: number;
  call_count: number;
}

export interface ProviderUsageSummary {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  call_count: number;
  by_provider: Record<string, ProviderStat>;
  by_model: Record<string, ModelStat>;
}

export type MessageRole = 'user' | 'assistant';

export type MemoryStatus = 'active' | 'superseded' | 'retracted';

export interface MemoryItem {
  id: string;
  userId: string;
  entityId: string | null;
  kind: string;
  content: string;
  source: string | null;
  sourceRef: string | null;
  confidence: number;
  sensitivity: string;
  scope: string;
  status: MemoryStatus;
  validFrom: string | null;
  validTo: string | null;
  supersedes: string | null;
  userConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TelemetryData {
  connected: boolean;
  temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  light: number | null;
  accelerometer: [number, number, number] | number[] | null;
  ok?: boolean;
}

export interface ActiveTaskItem {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'queued' | 'failed' | string;
  progress?: number;
  details?: string | null;
  started_at?: string | null;
}

export interface ScheduledTimerItem {
  id: string;
  name: string;
  schedule: string;
  next_run?: string | null;
  enabled?: boolean;
}

export interface MonitorStatus {
  status: string;
  cpu_pct: number;
  memory_rss_mb: number;
  temperature_c: number | null;
  load_1m?: number | null;
  active_tasks: ActiveTaskItem[];
  scheduled_timers: ScheduledTimerItem[];
  pending_approvals: ApprovalRequest[];
  uptime_seconds?: number;
  timestamp?: string;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  icon: string;
  description: string;
  endpoint: string;
}

export interface WorkflowExecutionResponse {
  workflow: string;
  status: 'completed' | 'failed' | 'running' | string;
  summary: string;
  timestamp: string;
  data: Record<string, unknown>;
}

