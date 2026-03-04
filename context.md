# Potaeto – Project Context

**Last updated:** After UI/UX overhaul, proactive messaging, streaming fixes, build error resolution, and end-to-end code review.

**Design doc:** See **RESEARCH_AND_DESIGN.md** for: skills pipeline (`pipeline_config`, SkillsService), streaming `/v1/chat/stream`, proactive messaging, admin panel tasks, UI principles, and implementation order. Keep context.md in sync when making structural or feature changes so other agents can navigate.

## What is Potaeto

Potaeto is a user-friendly, multiplatform MVP app where users:
1. Log in (magic link or OAuth via Supabase).
2. Describe **WHO and WHAT** they want to build (character/persona) via **text or voice**.
3. Interact via **chatbot** (streaming) or **script-based avatar** (script + TTS + simple avatar).
4. Generate **image** and **text** (MVP); video and music planned later.
5. **Export/share** via entity profile links and direct content links.
6. Receive **proactive messages** from their entities (entity reaches out when idle).

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React, Tailwind CSS, TypeScript. Runs as a PWA. Custom design system with `card`, `btn-primary`, `btn-secondary`, `btn-ghost`, `input-field` utility classes. Warm potato-themed palette.
- **Backend / BaaS:** Supabase (Auth, Postgres, Storage, RLS, pgvector).
- **Orchestrator:** Python FastAPI in `apps/orchestrator`; routes by `models_config` (Gemini, Groq, Hugging Face); logs to `model_usage_logs`. Endpoints: `POST /v1/chat`, `POST /v1/chat/stream`, `POST /v1/summarize`, `POST /v1/skills/{id}/invoke`, `POST /v1/parse-entity`, `POST /v1/proactive`. **Skills:** `app/skills/service.py` (SkillsService) loads `skills.pipeline_config` from DB and runs steps (llm, postprocess); prompt templates in `app/skills/prompts.py`. Migration `20260301000015_skills_pipeline_config_seed.sql` seeds songwriter with pipeline_config.
- **AI:** Google Gemini API (text, image, TTS) + optional Groq + Hugging Face-backed models, all abstracted behind the orchestrator for most flows. Default text model for direct Gemini usage: `gemini-2.5-flash`. Override with env: `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`. Optional: user-provided Gemini API key in profile.
- **Smart Router:** `ProviderHealthTracker` in orchestrator tracks per-(provider, model_key) health with rolling success rate, exponential cooldown on 429s, and health-penalty-based re-ranking. See "Smart Routing Algorithm" section below.
- **Voice input:** `react-speech-recognition` (Web Speech API) for "describe WHO/WHAT" by voice.

## Repo Structure

High level:

```
apps/
  web/                     # (planned) Next.js PWA (currently at repo root src/)
  orchestrator/            # Python FastAPI model router & skills orchestrator

supabase/
  migrations/              # SQL migrations for all tables
  config.toml
```

Frontend (current layout under `src/`):

```
src/
  app/
    (auth)/login/          # Login (magic link + OAuth)
    (app)/                 # Authenticated app
      onboarding/          # First-time: describe WHO/WHAT
      create/              # Edit entity, add avatar
      chat/[entityId]/     # Chat with entity (streaming + proactive message labels)
      avatar/[entityId]/   # Script-based avatar + TTS
      library/             # Generated content + image/text gen
      share/               # Share links
    api/
      auth/                # Supabase auth callback
      ai/
        parse-entity/      # POST: text/voice → WHO/WHAT JSON (delegates to orchestrator /v1/parse-entity)
        chat/              # POST: streaming chat (orchestrator /v1/chat/stream); client calls finalize after stream
        chat/finalize/     # POST: persist assistant message + run summary (called by client after stream ends)
        script/            # POST: generate script
        tts/               # POST: text → speech
        generate/
          image/           # POST: image generation
          text/            # POST: text generation
      skills/
        songwriter/invoke/ # POST: invoke songwriter skill (orchestrator /v1/skills/{id}/invoke, pipeline_config or legacy)
      entities/[entityId]/ # GET/PATCH: entity CRUD
      entities/[entityId]/skill-outputs/ # GET: recent skill_outputs for entity (for Skills history UI)
      conversations/[entityId]/messages/  # GET: load persisted chat history (includes meta for proactive labels)
      proactive/trigger/   # POST: trigger proactive messages for idle conversations (admin-protected)
      admin/
        models/            # GET: aggregated usage stats; PATCH: update model config (admin-protected)
    admin/                 # Admin dashboard (metrics, models, skills, memory/logs)
  components/
    SkillsSection.tsx     # Skills block: collapsible, songwriter card + recent outputs list + detail modal
    SongwriterSkillCard   # Invoke songwriter; optional onSuccess callback
    VoiceInput.tsx        # Voice input component using Web Speech API
  lib/
    supabase/              # client, server, middleware
    gemini.ts              # env-driven model config helpers
    chat-memory.ts         # maybeUpdateSummary (used by chat + finalize routes)
  types/
```

## Data Model

- **profiles**: id (→ auth.users), username, avatar_url, gemini_api_key_encrypted, is_public.
- **entities**: id, user_id, name, slug, characteristics (JSONB), appearance (JSONB), persona (JSONB), skills (JSONB), attributes (JSONB), avatar_asset_url, is_public.
- **content**: id, user_id, entity_id, type (image|video|audio|text), storage_path, public_url, metadata (JSONB).
- **conversations**: id, user_id, entity_id, title, created_at, updated_at (one per user×entity for now).
- **messages**: id, conversation_id, user_id, role (`user`/`assistant`/`system`), content, meta (JSONB — includes `{ proactive: true }` for entity-initiated messages), created_at.
- **conversation_summaries**: conversation_id (PK), user_id, entity_id, summary, last_message_id, updated_at.
- **memories**: id, user_id, entity_id, kind (`summary`/`fact`/`preference`/`event`), content, embedding (vector), weight, created_at.
- **models_config**: id, provider, model_key, display_name, task_type, priority, enabled, temperature, top_p, max_output_tokens, cost fields, rate_limit_rpm, group, extra.
- **model_usage_logs**: id, created_at, task_type, provider, model_key, success, latency_ms, error_message, metadata (JSONB).
- **skills**: id (`songwriter`, `painter`, ...), name, description, icon, category, pipeline_config (JSONB).
- **entity_skills**: (entity_id, skill_id) PK, config (JSONB), enabled.
- **skill_outputs**: id, user_id, entity_id, skill_id, content_type, storage_path/public_url or text_content, metadata, created_at.

Storage buckets: `avatars`, `content` (public URLs for shareable content).

## Proactive Messaging

- **Data model:** Minimal — uses existing `conversations`, `messages`, `memories`, `conversation_summaries`. Proactive messages are assistant messages with `meta.proactive = true`.
- **Orchestrator:** `POST /v1/proactive` with `task_type: proactive_message`. Generates a short, in-character message from the entity based on persona, summary, and recent facts.
- **Trigger:** `POST /api/proactive/trigger` (protected by ADMIN_SECRET). Finds conversations idle for 24h+, avoids re-sending within the same period, generates messages via orchestrator, and inserts them with `meta.proactive = true`.
- **Scheduling:** Can be called by Supabase pg_cron + Edge Function, Cloudflare Cron Worker, or manual admin trigger. Same contract.
- **ChatUI:** Proactive messages display with a subtle "{entity} reached out" label above the message bubble.

## Smart Routing Algorithm

The orchestrator's `ModelRouter` uses a `ProviderHealthTracker` (`app/router/health.py`) for intelligent provider selection:

**How it works:**
1. Load enabled models for the task_type from DB, sorted by base priority.
2. Split into AVAILABLE (not cooling down) and COOLING_DOWN lists.
3. Sort AVAILABLE by effective_priority = base_priority + health_penalty:
   - 0 penalty if success_rate >= 90% (healthy)
   - +50 if 50-90% (degraded)
   - +200 if < 50% (unhealthy)
   This means a priority-1 model with terrible health (effective 201) is tried AFTER a healthy priority-10 model.
4. Try AVAILABLE models in effective order. On success, done.
5. If all AVAILABLE fail, try COOLING_DOWN as last resort (nearest-to-recovery first).

**Cooldown on errors:**
- **429 / rate-limit**: Exponential backoff starting at 15s, doubling each consecutive 429 (15 → 30 → 60 → 120 → 300s max). The model is SKIPPED for new requests during cooldown, so traffic flows to other providers instead of extending the rate-limit window.
- **Other errors (500, network)**: Shorter backoff (3s → 6s → 12s → ... → 30s max).
- **On success**: Consecutive error counters reset, model returns to normal.

**Health tracking:**
- Per-(provider, model_key) — different models on the same provider tracked independently.
- Rolling window of last 30 outcomes for success rate calculation.
- Thread-safe, in-memory (resets on orchestrator restart — intentional, avoids stale state).

**Admin visibility:**
- `GET /v1/health` on orchestrator returns live health snapshots.
- `/admin/models` shows live health table (auto-refreshes every 10s): success rate, cooldown status, consecutive rate limits, health penalty.

## Design System (UI/UX)

- **Palette:** Warm potato-themed (`potato-50` to `potato-950`). CSS variables: `--foreground`, `--background`, `--card`, `--card-border`, `--muted`, `--accent`.
- **Components:** `card` (rounded-2xl border shadow), `btn-primary` (potato-500 bg), `btn-secondary` (bordered), `btn-ghost` (transparent hover), `input-field` (rounded-xl with focus ring), `label`, `section-title`, `page-title`.
- **Animations:** `animate-fade-in` (opacity + translateY), `animate-slide-up` (larger translateY), `typing-dot` (bouncing dots for loading).
- **Patterns:** Every page uses consistent card wrappers, loading states, error messages. Chat uses proper streaming cursor (blinking bar during stream, bouncing dots while waiting).
- **Responsive:** All pages stack vertically on mobile with touch-friendly button sizes.
- **Scrollbar:** Custom thin scrollbar (`scrollbar-thin` class).

## Configuration

All tunable values are centralized:
- **Next.js:** `src/lib/config.ts` — all limits, URLs, thresholds as env-driven constants.
- **Orchestrator:** `apps/orchestrator/app/config.py` — `HealthSettings`, `RoutingSettings`, `SupabaseSettings`, `GeminiSettings`, all env-driven with sensible defaults.
- **`.env.example`:** Documents every available env var with defaults.
- **No hardcoded magic numbers** in API routes or components — everything imports from config.

## Deployment

- **Frontend (Next.js):** Deploy to Vercel (or any Node.js host). Set env vars from `.env.example`.
- **Orchestrator (FastAPI):** Deploy to Render using `render.yaml` blueprint. Dockerfile at `apps/orchestrator/Dockerfile`.
  - Health check: `GET /v1/health` (used by Render for liveness).
  - Single worker (`--workers 1`) for free tier memory constraints.
  - `--timeout-keep-alive 65` to survive Render's 60s proxy timeout.
  - Startup warm-up: pre-loads models_config cache for common task types.
  - Cache invalidation: `POST /v1/cache/invalidate` (called automatically after admin model config changes).

## Free-Tier Optimizations

- **models_config cache:** TTL-based in-memory cache (`MODELS_CONFIG_CACHE_TTL_SEC`, default 60s) avoids hitting Supabase on every request. Admin changes trigger `POST /v1/cache/invalidate`.
- **skills config cache:** Skill pipeline_config cached in-memory (120s TTL).
- **Shared Supabase client:** SkillsService reuses the router's client instead of creating a new one per request.
- **Startup warm-up:** On boot, pre-loads models_config for chat_primary, summarize, skill_text to reduce first-request latency after Render cold start.
- **Config-driven providers:** Only providers listed in `ENABLED_PROVIDERS` are initialized, saving memory and startup time.
- **Single uvicorn worker:** Fits in Render free tier's 512MB RAM.

## Conventions

- **Scalability:** Server-side Gemini only; Supabase RLS for multi-tenant isolation; stateless API routes so you can scale horizontally.
- **Secrets:** `GOOGLE_GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` only in env; never in client. User Gemini key stored encrypted in profile, used only server-side when present.
- **context.md:** Single source of context for other IDEs/agents; update after each significant iteration.

## Current MVP Scope

- **In:** Login, one WHO/WHAT creation (text + voice), chatbot with streaming + optional TTS, script-based avatar (script + TTS + static avatar), image + text generation, entity profile and content share links, proactive messaging, skills pipeline (songwriter), admin dashboard.
- **Later:** Video (Veo), music (Lyria), user profile page, multiple entities, full video export, advanced skills (multi-step pipelines with HTTP steps).

## How to Run

1. Copy `.env.example` to `.env.local` and set Supabase + Gemini keys.
2. Run Supabase migrations: use **Supabase MCP** (if enabled), **Supabase CLI** (`supabase link` then `supabase db push`), or **Dashboard** SQL editor — run files in `supabase/migrations/` in order.
3. `npm install` then `npm run dev` (Next.js web).
4. (When ready) In `apps/orchestrator`, install Python deps (`pip install -e .`) and run `uvicorn app.main:app --reload` to start the orchestrator API.
5. (Optional) Set up a cron to call `POST /api/proactive/trigger` with `X-Admin-Secret` header for proactive messaging.

## Admin

- Admin overview at `/admin` (protected via `ADMIN_SECRET` header): users, entities, content, conversations, messages, skill outputs, **plus model usage health card** (total API calls, recent error rate, success %, top provider).
- `/admin/models`: **Full model management dashboard** with:
  - **Usage summary cards**: total API calls, total errors, success rate, active providers.
  - **Per-provider breakdown**: calls, errors, success rate, avg latency, usage share bar per provider.
  - **Per-task breakdown**: calls and errors per task type (chat_primary, summarize, skill_text, etc.) with share percentages.
  - **Configured models table** with **inline editing**: toggle enabled/disabled (switch), edit priority/temperature/max_output_tokens. All-time per-model stats (calls, errors, avg ms).
  - **API**: `PATCH /api/admin/models` to update model config. `GET /api/admin/models` returns aggregated usage stats.
- `/admin/skills`: read-only view of `skills` catalog + `entity_skills` usage + pipeline_config status.
- `/admin/memory`: read-only view of recent `conversation_summaries`, `memories`, and `model_usage_logs`.
- **Implemented:** `src/app/admin/layout.tsx` provides shared layout: auth check (ADMIN_SECRET), sticky header with nav icons (Overview, Models, Skills, Memory & Logs).

## Conventions for maintainability

- **Structure:** Orchestrator in `apps/orchestrator`; Next.js in `src/`; Supabase migrations in `supabase/migrations`. Group by domain (e.g. skills, chat, admin).
- **Restructuring:** Prefer incremental refactors; extract shared types, admin layout, or `lib/` helpers as needed. Document in context.md.
- **Proactive messaging:** Minimal data model (no new tables); use `messages.meta.proactive` to mark proactive messages. Scheduler: call `POST /api/proactive/trigger` via Supabase pg_cron + Edge Function **or** Cloudflare Cron + Worker (see RESEARCH_AND_DESIGN.md).
- **Dynamic route naming:** All routes under `/api/entities/` use `[entityId]` consistently (not `[id]`).

## Recent Changes (this iteration)

1. **Build fixes:** Resolved dynamic route slug conflict (`[id]` vs `[entityId]` under `/api/entities/`), TypeScript type assertion syntax errors in script/text/image gen routes, missing `@types/react-speech-recognition`, implicit `any` in cookie params, manifest `purpose` type, and SDK `systemInstruction` parameter.
2. **UI/UX overhaul:** Complete redesign of all pages with custom design system (CSS utility classes), animations, proper streaming indicators, responsive layout, consistent card/button components.
3. **Proactive messaging:** New orchestrator endpoint (`POST /v1/proactive`), new `proactive_message` task type, trigger API (`POST /api/proactive/trigger`) with idle detection, and ChatUI proactive message labels.
4. **VoiceInput fix:** Prevents duplicate/repeated transcript sends using ref tracking.
5. **Admin dashboard:** Enhanced with conversation count, message count, skill output count, pipeline_config status indicators, and memory kind badges.
6. **Admin models page rewrite:** Full model management dashboard with per-provider usage breakdown, per-task breakdown, all-time stats, inline editing (toggle enabled, change priority/temperature/max_output_tokens), and admin PATCH API.
7. **Admin overview:** Added model usage health card showing total API calls, recent error rate, success rate, and top provider.
8. **Smart routing algorithm:** `ProviderHealthTracker` in orchestrator with per-model health tracking, exponential cooldown on 429s, health-penalty re-ranking, and fallback-to-cooling-down logic. Live health visible in admin panel with auto-refresh.
9. **Orchestrator health endpoint:** `GET /v1/health` returns live provider health snapshots. Proxied via `GET /api/admin/health` for admin panel.
10. **Config centralization:** `src/lib/config.ts` for Next.js, `apps/orchestrator/app/config.py` for orchestrator. All hardcoded limits, URLs, thresholds extracted to env-driven config. 50+ values now configurable via env vars.
11. **Render deployment:** Dockerfile, render.yaml blueprint, .dockerignore, health check endpoint, startup warm-up.
12. **Free-tier optimizations:** models_config TTL cache, skills config cache, shared Supabase client, startup warm-up, config-driven provider lazy loading, cache invalidation on admin changes.
