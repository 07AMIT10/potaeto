# Potaeto – Research & Design: Skills, Streaming, Proactive Messaging, UI

**Scope:** Free-only product for now (no paid/free routing or quotas). Focus on: generic skills pipeline, streaming chat, proactive entity-initiated messages, and a polished UI.

**Sources:** Codebase exploration; agent transcripts (plan status, orchestrator wiring, admin dashboards, chat via orchestrator, remaining work and research directions).

---

## 1. Current State (from codebase + transcripts)

### Implemented
- **Memory:** `conversations`, `messages`, `conversation_summaries`, `memories`; chat route builds system prompt with summary + memories; `maybeUpdateSummary` calls orchestrator `/v1/summarize`.
- **Orchestrator:** FastAPI in `apps/orchestrator`; providers Gemini, Groq, Hugging Face; `ModelRouter` by `task_type` from `models_config`; `model_usage_logs`; endpoints: `/v1/chat`, `/v1/summarize`, `/v1/skills/{skill_id}/invoke`, `/v1/parse-entity`.
- **Chat:** Next.js `api/ai/chat` → orchestrator `/v1/chat`; stores user/assistant in `messages`; returns **single response** (no token-level streaming). ChatUI uses `getReader()` but receives one chunk.
- **Skills:** Only `songwriter` hardcoded in orchestrator; Next.js `api/skills/songwriter/invoke` + `SongwriterSkillCard` on chat page; writes to `skill_outputs`. `skills.pipeline_config` exists in DB but is unused.
- **Admin:** `/admin`, `/admin/models`, `/admin/skills`, `/admin/memory` (read-only).

### Not implemented (in scope here)
- Generic **skills pipeline** driven by `pipeline_config` and a **SkillsService**.
- **Streaming** `/v1/chat` (and Next.js proxy) for real token-by-token UX.
- **Proactive messaging**: entity asks user things (e.g. “How was your day?”, follow-up on “big meeting”) via **scheduled jobs** (e.g. pg_cron + Edge Function or worker).
- **Skills history UI**: entity profile tab for skills + last N `skill_outputs` with detail modal.
- **UI polish** and consistent patterns for chat + skills.

---

## 2. Skills System (generic pipelines, pipeline_config, SkillsService, history UI)

### 2.1 Pipeline abstraction

**Goal:** Replace `if skill_id == "songwriter"` with a declarative pipeline so new skills (including multi-step) are data-driven.

**`skills.pipeline_config` (JSONB) – constrained DSL**

```json
{
  "steps": [
    { "id": "step1", "type": "llm", "task_type": "skill_text", "prompt_template_id": "songwriter_v1" },
    { "id": "step2", "type": "postprocess", "kind": "trim" }
  ],
  "inputs": ["prompt", "entity_name", "persona"],
  "outputs": ["lyrics"]
}
```

- **steps:** Ordered list. Types: `llm` (uses ModelRouter + optional `prompt_template_id`), `image`, `postprocess` (e.g. trim/summarize), `http` (future: call external API).
- **inputs/outputs:** Named slots; step outputs feed next step’s inputs by name. First step gets request payload; last step’s output is the skill result.
- Keep it **sequential** for now (no DAG). Design so we can later add branching or parallel steps.

**Orchestrator: SkillsService**

- **Load:** By `skill_id` → `skills` row + `pipeline_config`.
- **Execute:** For each step in order:
  - **llm:** Build messages from template (or default) + current context; call `ModelRouter.generate_text(task_type, messages)`; pass result to next step by output name.
  - **postprocess:** In-process (e.g. trim, wrap).
  - **http:** (Later) Call external API with templated URL/body; store result in slot.
- **Persist:** Write final (and optionally intermediate) results to `skill_outputs` with `metadata`: `{ "pipeline_step_id": "...", "model_key": "...", "prompt_preview": "..." }`.

**Generic entry point**

- `POST /v1/skills/{skill_id}/invoke`: Resolve skill from DB; if `pipeline_config` is non-empty, run SkillsService; else fall back to current hardcoded songwriter (or a single generic LLM step). No more `if skill_id == "songwriter"` in main.py; songwriter becomes a row in `skills` with a `pipeline_config` that has one LLM step with a songwriter prompt template.

**Prompt templates**

- Store in DB or code: e.g. `songwriter_v1` = “You are a creative songwriter…”. SkillsService resolves template by id and injects `prompt`, `entity_name`, `persona` into the message.

### 2.2 Skills UI / history

- **Entity profile / chat page:** Add a **Skills** section (tab or collapsible):
  - List **enabled skills** for this entity (`entity_skills`).
  - Per skill: last **N** (e.g. 5) **skill_outputs** with: timestamp, small preview (text snippet or image thumbnail), optional “View” button.
- **Detail modal:** On “View”, show one `skill_output`: full content, metadata (pipeline step, model, prompt snippet), and link to share if we add public_url later.
- Reuse the same “invoke” pattern (input + “Generate” button) for any skill that has a single user-facing input (e.g. prompt). Multi-input skills can get a small form later.

**Design principle:** One coherent place (entity → Skills) to see what this entity can do and what it has produced; same pattern for songwriter and future skills.

---

## 3. Orchestrator streaming and routing (free-only)

### 3.1 Streaming `/v1/chat`

**Goal:** Token-level streaming end-to-end so the UI feels responsive.

- **Orchestrator:** Add `POST /v1/chat/stream` (or optional `?stream=true` on `/v1/chat`):
  - Same request body as `/v1/chat` (messages, task_type).
  - Use **provider streaming APIs** where available:
    - **Gemini:** `generate_content_stream` (or equivalent in `google-genai` SDK) → iterate chunks, yield text deltas.
    - **Groq:** `stream=True` in client → async stream.
    - **Hugging Face:** `stream=True` in chat completions.
  - Response: **SSE** (`Content-Type: text/event-stream`) or **chunked transfer** with `text/plain` chunks (one chunk per token or small aggregate). Prefer SSE for clarity and compatibility.

- **Next.js:** New route e.g. `api/ai/chat/stream` (or same `api/ai/chat` with `Accept` or query param):
  - Proxy request to orchestrator `/v1/chat/stream`.
  - Stream response back to client (no buffering); return `ReadableStream` so the client keeps using `getReader()`.

- **ChatUI:** Keep current `getReader()` loop; it will now receive many small chunks and update the last message in real time. Optionally add a “streaming” cursor or subtle animation.

**Free-only:** No change to routing logic; we still pick model by `task_type` and `priority` from `models_config`. No cost or quota checks.

### 3.2 Routing (free-only simplification)

- **No** plan-aware or cost-aware routing for now (everything is free). Keep current behavior: first enabled model by priority for the task_type; fallback on failure.
- **Optional later:** Use `model_usage_logs` for health (e.g. auto-disable a model after N consecutive failures) or latency-based reordering. Not in initial scope.

---

## 4. Proactive messaging (scheduled jobs; entity asks the user)

**Data model: keep minimal**—no new tables for now; use existing `conversations`/`messages`/`memories`/`conversation_summaries`. Optionally set `messages.meta.proactive` when inserting proactive assistant messages.

**Goal:** The entity initiates messages sometimes: “How was your day?”, “How did that meeting go?”, “You mentioned a project deadline—any update?”. All free; no quotas.

### 4.1 Data model for “proactive opportunities”

- **Option A – Minimal:** Use existing tables only.
  - **Idle detection:** Conversations with `updated_at` (or last message `created_at`) older than threshold (e.g. 24h) and at least one message → “user hasn’t chatted in a while”.
  - **Follow-ups:** From `memories` (e.g. `kind = 'fact'` or `'event'`) and/or `conversation_summaries.summary` → extract topics (e.g. “big meeting”, “project X”) to ask about. No new table; logic in the job.

- **Option B – Explicit triggers (recommended for clarity):**
  - New table **`proactive_triggers`** (or columns on `entities` / profile):
    - `user_id`, `entity_id`, `trigger_type` (‘idle’ | ‘follow_up’), `config` (e.g. `{ "idle_hours": 24 }`, `{ "memory_id": "..." }`), `last_triggered_at`, `enabled`.
  - Allows per-entity or per-user settings (e.g. “remind me about X in 2 days”) and avoids re-sending the same follow-up too often.

Recommendation: Start with **Option A** (no new table) for “idle” and “follow-up from recent summary/memories”. If we need per-user scheduling or reminders, add **Option B** later.

### 4.2 Scheduling: pg_cron + Edge Function **or** Cloudflare Cron (both free)

- **Option 1 – Supabase:** **pg_cron** runs on a schedule (e.g. every hour or twice daily). Job runs **SQL** or calls out via **pg_net**.
- **Preferred (Supabase):** Cron job calls a **Supabase Edge Function** (e.g. `proactive-messages`) with auth stored in Vault (project URL + service role or anon key). Edge Function:
  1. Queries Supabase for “proactive opportunities”:
     - Idle: conversations where last message or `updated_at` is older than threshold (e.g. 24h) and user has at least one conversation.
     - Follow-ups: recent `memories` / `conversation_summaries` for that user+entity; optionally filter by time (e.g. fact from last 2 days).
  2. For each (user_id, entity_id) pair (cap per run to avoid overload):
     - Call **orchestrator** with a dedicated `task_type`, e.g. `proactive_message`, and context: entity name/persona, summary, recent facts, and optionally the topic to ask about (e.g. “User had a big meeting”).
     - Orchestrator returns one short, in-character message (e.g. “How was your day?” or “How did the big meeting go?”).
  3. Insert that message as **assistant** into `messages` (same conversation_id) and bump `conversations.updated_at`.
  4. (Optional) Set `messages.meta = { "proactive": true }` when inserting (no new table) for “entity sent proactive message at X” so the UI can show “New from {entity}” or badge.

**Orchestrator:** Add `task_type: proactive_message` and a dedicated system prompt: “You are {entity}. Generate a single short, friendly message to re-engage the user. Options: ask how their day was, or ask about something they mentioned (e.g. meeting, project). One sentence or two; no list.” Input: entity name, persona, summary, recent facts, optional topic.

**Cloudflare Cron (also free):** Use **Cloudflare Workers** with **Cron Triggers**. Worker does the same: HTTP to Supabase for opportunities, call orchestrator, write back to Supabase. Only the scheduler differs; keep the proactive-run logic in one place (Edge Function or Worker) for maintainability.

### 4.3 Frontend

- **ChatUI:** On load (or when opening a conversation), show **new messages since last visit**: e.g. “2 new messages from {entity}” or simply show the new assistant messages in the thread (they’re already in `messages`). Optionally mark them as “proactive” in `meta` or by time so we can show a subtle “{entity} reached out” label.
- **Notifications (optional):** If we add a notifications table or in-app bell, surface “{entity} asked you something” with deep link to that chat.

---

## 5. UI principles (kickass, consistent)

- **Hierarchy and clarity:** One primary action per card/section (e.g. “Generate lyrics”); secondary actions (history, settings) clearly separated.
- **Feedback:** Loading states for every async action (spinner or skeleton); success = show result inline; errors = inline message with retry.
- **Streaming:** When streaming chat is on, show a subtle typing indicator or cursor so the user sees that the model is “writing”.
- **Skills:** Same card pattern for every skill: title, short description, input (prompt/form), primary button, result area. History below or in a tab.
- **Proactive:** Proactive messages appear as normal assistant bubbles; optional small label “{entity} asked” or icon so it’s clear it wasn’t a direct reply.
- **Accessibility:** Focus management, labels, contrast; avoid motion for critical paths.
- **Responsive:** Chat and skills usable on mobile (stack vertically, touch-friendly buttons).
- **Design system:** Reuse one palette (e.g. potato brand), one border-radius, one spacing scale so chat and skills and admin feel like one product.

---

## 6. Advanced skills (music, animation) – later

- **Music:** Multi-step pipeline: step 1 LLM (prompt/song structure), step 2 HTTP (e.g. Lyria or other API), step 3 store in `content` bucket and `skill_outputs` with `content_type = 'audio'`. Pipeline step type `http` with templated URL/body and secrets from env.
- **2D/3D avatar:** Same idea: LLM for script/shot list, then external or internal worker for assets; store refs in `skill_outputs`. No schema change beyond existing `content_type` and `storage_path`/`public_url`.

Design the pipeline DSL and SkillsService so that adding an `http` step type and a new skill row is enough to plug in these later.

---

## 7. Repo split (apps/web vs root) – later

- **Target:** Move Next.js app (src/, public/, next.config.*, package.json, etc.) under `apps/web/`; keep orchestrator in `apps/orchestrator/`; optional `packages/ui` or `packages/lib` for shared code.
- **Steps:** Move files → fix tsconfig/eslint paths → point Vercel (or deploy) to `apps/web` → update context.md.
- Defer until after streaming, proactive, and skills pipeline are in place so we don’t mix refactors.

---

## 8. Codebase maintainability and structure

- **Structure:** Keep a clear separation: `apps/orchestrator` (Python), `src/` (Next.js), `supabase/migrations` (schema). Avoid scattering one feature across many unrelated files; group by domain (e.g. skills, chat, admin).
- **Restructuring:** If existing code is hard to follow, refactor in small steps: extract shared types, a single admin layout, or a small `lib/` for orchestrator-calling helpers. Do not rewrite large areas in one go; prefer incremental, testable changes.
- **Naming and consistency:** Use the same patterns for API routes (e.g. `api/ai/...`, `api/skills/...`), and for components (e.g. one convention for “card” vs “panel”). Document in `context.md` so other agents and humans can navigate.

## 9. Admin panel (complete and harden)

- **Current state:** Read-only pages at `/admin`, `/admin/models`, `/admin/skills`, `/admin/memory`; protected by `ADMIN_SECRET` (e.g. header). They show counts, model configs, usage logs, skills catalog, summaries, memories.
- **Tasks:**
  - **Layout and nav:** Give admin a dedicated layout (e.g. `src/app/admin/layout.tsx`) with a sidebar or tab nav linking to Overview, Models, Skills, Memory so every admin page shares the same shell and is easy to find.
  - **Structure:** Reuse shared components (e.g. a simple `AdminTable`, `AdminCard`) where it reduces duplication without over-abstracting. Keep admin code under `src/app/admin/` and optionally `src/components/admin/` if components grow.
  - **Optional (later):** Edit for `models_config` or `skills` (enable/disable, priority) via API + UI; for now read-only is fine if editing stays in SQL/Dashboard. Document in context.md how to add edit flows later.
- **Goal:** Admin is discoverable, consistent, and maintainable; no “ruckus”—clear structure so future work (e.g. proactive logs, feature flags) can be added in one place.

## 10. Implementation order (recommended)

1. **Streaming**
   - Orchestrator: add streaming to Gemini (and Groq/HF if needed), expose `/v1/chat/stream`.
   - Next.js: `api/ai/chat` stream proxy (or new stream route).
   - ChatUI: already uses getReader(); verify multi-chunk behavior and optional typing indicator.

2. **Skills pipeline**
   - Define `pipeline_config` schema and document it (e.g. in context.md).
   - Implement SkillsService in orchestrator (load config, run steps, persist to skill_outputs).
   - Migrate songwriter to a `skills` row with `pipeline_config` (one LLM step); remove hardcoded branch in main.py.
   - Add prompt template resolution (in code or DB).

3. **Skills history UI**
   - Entity chat page: Skills section with list of enabled skills and last N skill_outputs; detail modal for one output.

4. **Proactive messaging**
   - Orchestrator: `proactive_message` task_type and prompt.
   - **Scheduler (choose one):** Supabase pg_cron + Edge Function **or** Cloudflare Cron + Worker. Same contract: query existing tables (minimal data model), call orchestrator, insert assistant message with optional `meta.proactive`.
   - ChatUI: optional “new since last visit” or “{entity} asked” label using `meta.proactive`.

5. **Admin panel**
   - Add admin layout with nav (Overview, Models, Skills, Memory). Extract shared admin components if useful; keep structure under `src/app/admin/` (and optional `src/components/admin/`). Update context.md with admin entry points and conventions.

6. **UI polish**
   - Apply the principles above to Chat + Skills (loading, errors, streaming cursor, consistency). Optional: shared SkillCard wrapper for any skill.

7. **Later**
   - Advanced skills (music, animation) when external APIs are ready.
   - Repo split to `apps/web` when convenient.

---

## 11. Summary

| Area | Decision |
|------|----------|
| **Skills** | Generic pipeline in `pipeline_config`; SkillsService in orchestrator; songwriter becomes data-driven; Skills tab + history + detail modal on entity. |
| **Streaming** | `/v1/chat/stream` + provider streaming; Next.js proxy; ChatUI unchanged reader, real token stream. |
| **Routing** | Free-only; keep priority-based; no cost/plan logic. |
| **Proactive** | **Minimal data model:** existing tables only; optional `messages.meta.proactive`. **Scheduler:** Supabase pg_cron + Edge Function **or** Cloudflare Cron + Worker (both free); same contract. |
| **Admin** | Dedicated layout + nav; shared components; keep under `src/app/admin/`; document in context.md. |
| **Maintainability** | Clear structure; incremental refactors; document patterns in context.md for other agents. |
| **UI** | One pattern for skills; clear feedback and streaming; optional “proactive” label. |
| **Repo split** | Defer. |

Once this plan is agreed, implementation can start with streaming, then skills pipeline + history UI, then proactive messaging, then admin panel + UI polish. Use subagents for independent workstreams (e.g. orchestrator streaming vs Next.js proxy vs admin layout) where it helps.
