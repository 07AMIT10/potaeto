/**
 * Centralized configuration — all tunable constants in one place.
 * Values come from env vars with sensible defaults for local dev.
 * 
 * Naming convention: SECTION_SETTING (e.g. CHAT_RECENT_MESSAGES_LIMIT).
 * Server-only values (secrets, URLs) should never start with NEXT_PUBLIC_.
 */

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function envStr(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

// ── Orchestrator ────────────────────────────────────────────────────
export const ORCHESTRATOR_URL = envStr('ORCHESTRATOR_URL', 'http://localhost:8000');

// ── Chat & conversation ─────────────────────────────────────────────
export const CHAT_RECENT_MESSAGES_LIMIT = envInt('CHAT_RECENT_MESSAGES_LIMIT', 10);
export const CHAT_MEMORIES_LIMIT = envInt('CHAT_MEMORIES_LIMIT', 5);
export const CONVERSATION_HISTORY_LIMIT = envInt('CONVERSATION_HISTORY_LIMIT', 50);

// ── Summary / memory ────────────────────────────────────────────────
export const SUMMARY_TRIGGER_EVERY = envInt('SUMMARY_TRIGGER_EVERY', 10);
export const SUMMARY_MAX_CHARS = envInt('SUMMARY_MAX_CHARS', 1200);
export const SUMMARY_SOURCE_MESSAGES = envInt('SUMMARY_SOURCE_MESSAGES', 20);

// ── Proactive messaging ─────────────────────────────────────────────
export const PROACTIVE_IDLE_HOURS = envInt('PROACTIVE_IDLE_HOURS', 24);
export const PROACTIVE_MAX_PER_RUN = envInt('PROACTIVE_MAX_PER_RUN', 10);
export const PROACTIVE_FACTS_LIMIT = envInt('PROACTIVE_FACTS_LIMIT', 5);

// ── Skills ──────────────────────────────────────────────────────────
export const SKILL_OUTPUTS_DEFAULT_LIMIT = envInt('SKILL_OUTPUTS_DEFAULT_LIMIT', 15);
export const SKILL_OUTPUTS_MAX_LIMIT = envInt('SKILL_OUTPUTS_MAX_LIMIT', 50);

// ── TTS ─────────────────────────────────────────────────────────────
export const GEMINI_TTS_VOICE = envStr('GEMINI_TTS_VOICE', 'Kore');

// ── Admin ───────────────────────────────────────────────────────────
export const ADMIN_LOGS_LIMIT = envInt('ADMIN_LOGS_LIMIT', 1000);
export const ADMIN_USAGE_LOGS_LIMIT = envInt('ADMIN_USAGE_LOGS_LIMIT', 5000);
export const ADMIN_MEMORY_LIMIT = envInt('ADMIN_MEMORY_LIMIT', 30);
export const ADMIN_ROUTING_LOGS_LIMIT = envInt('ADMIN_ROUTING_LOGS_LIMIT', 50);

// ── Library / Share ─────────────────────────────────────────────────
export const LIBRARY_CONTENT_LIMIT = envInt('LIBRARY_CONTENT_LIMIT', 50);
export const SHARE_CONTENT_LIMIT = envInt('SHARE_CONTENT_LIMIT', 30);

// ── Public "try" chat on /e/[id] ──────────────────────────────────────
/** Max user turns per browser (enforced server-side). */
export const PUBLIC_TRY_MAX_USER_MESSAGES = envInt('PUBLIC_TRY_MAX_USER_MESSAGES', 6);
