# Potaeto – Project Context

**Last updated:** After skills pipeline (SkillsService, pipeline_config), Skills history UI (SkillsSection, GET skill-outputs), and songwriter seed migration.

**Design doc:** See **RESEARCH_AND_DESIGN.md** for: skills pipeline (`pipeline_config`, SkillsService), streaming `/v1/chat/stream`, proactive messaging (minimal data model; pg_cron or Cloudflare Cron), admin panel tasks, UI principles, and implementation order. Keep context.md in sync when making structural or feature changes so other agents can navigate.

## What is Potaeto

Potaeto is a user-friendly, multiplatform MVP app where users:
1. Log in (magic link or OAuth via Supabase).
2. Describe **WHO and WHAT** they want to build (character/persona) via **text or voice**.
3. Interact via **chatbot** or **script-based avatar** (script + TTS + simple avatar).
4. Generate **image** and **text** (MVP); video and music planned later.
5. **Export/share** via entity profile links and direct content links.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React, Tailwind CSS, TypeScript. Runs as a PWA.
- **Backend / BaaS:** Supabase (Auth, Postgres, Storage, RLS, pgvector).
- **Orchestrator:** Python FastAPI in `apps/orchestrator`; routes by `models_config` (Gemini, Groq, Hugging Face); logs to `model_usage_logs`. Endpoints: `POST /v1/chat`, `POST /v1/chat/stream`, `POST /v1/summarize`, `POST /v1/skills/{id}/invoke`, `POST /v1/parse-entity`. **Skills:** `app/skills/service.py` (SkillsService) loads `skills.pipeline_config` from DB and runs steps (llm, postprocess); prompt templates in `app/skills/prompts.py`. Migration `20260301000015_skills_pipeline_config_seed.sql` seeds songwriter with pipeline_config.
- **AI:** Google Gemini API (text, image, TTS) + optional Groq + Hugging Face-backed models, all abstracted behind the orchestrator for most flows. Default text model for direct Gemini usage: `gemini-2.5-flash`. Override with env: `GEMINI_MODEL`, `GEMINI_SUMMARY_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`. Optional: user-provided Gemini API key in profile.
- **Voice input:** `react-speech-recognition` (Web Speech API) for “describe WHO/WHAT” by voice.

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
      chat/[entityId]/     # Chat with entity (now backed by conversations/messages)
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
      entities/[entityId]/skill-outputs/ # GET: recent skill_outputs for entity (for Skills history UI)
      conversations/[entityId]/messages/  # GET: load persisted chat history
    admin/                 # Admin dashboard (metrics, models, skills, memory/logs)
  components/
    SkillsSection.tsx     # Skills block: songwriter card + recent outputs list + detail modal
    SongwriterSkillCard   # Invoke songwriter; optional onSuccess callback
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
- **messages**: id, conversation_id, user_id, role (`user`/`assistant`/`system`), content, meta, created_at.
- **conversation_summaries**: conversation_id (PK), user_id, entity_id, summary, last_message_id, updated_at.
- **memories**: id, user_id, entity_id, kind (`summary`/`fact`/`preference`/`event`), content, embedding (vector), weight, created_at.
- **models_config**: id, provider, model_key, display_name, task_type, priority, enabled, temperature, top_p, max_output_tokens, cost fields, rate_limit_rpm, group, extra.
- **model_usage_logs**: id, created_at, task_type, provider, model_key, success, latency_ms, error_message, metadata (JSONB).
- **skills**: id (`songwriter`, `painter`, ...), name, description, icon, category, pipeline_config (JSONB).
- **entity_skills**: (entity_id, skill_id) PK, config (JSONB), enabled.
- **skill_outputs**: id, user_id, entity_id, skill_id, content_type, storage_path/public_url or text_content, metadata, created_at.

Storage buckets: `avatars`, `content` (public URLs for shareable content).

## Conventions

- **Scalability:** Server-side Gemini only; Supabase RLS for multi-tenant isolation; stateless API routes so you can scale horizontally.
- **Secrets:** `GOOGLE_GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` only in env; never in client. User Gemini key stored encrypted in profile, used only server-side when present.
- **context.md:** Single source of context for other IDEs/agents; update after each significant iteration.

## Current MVP Scope

- In: Login, one WHO/WHAT creation (text + voice), chatbot with streaming + optional TTS, script-based avatar (script + TTS + static avatar), image + text generation, entity profile and content share links.
- Later: Video (Veo), music (Lyria), user profile page, multiple entities, full video export.

## How to Run

1. Copy `.env.example` to `.env.local` and set Supabase + Gemini keys.
2. Run Supabase migrations: use **Supabase MCP** (if enabled), **Supabase CLI** (`supabase link` then `supabase db push`), or **Dashboard** SQL editor — run files in `supabase/migrations/` in order.
3. `npm install` then `npm run dev` (Next.js web).
4. (When ready) In `apps/orchestrator`, install Python deps (`pip install -e .`) and run `uvicorn app.main:app --reload` to start the orchestrator API.

## Admin

- Admin overview at `/admin` (protected via `ADMIN_SECRET` header): users, entities, content, plus links.
- `/admin/models`: read-only view of `models_config` and recent `model_usage_logs` stats.
- `/admin/skills`: read-only view of `skills` catalog + `entity_skills` usage.
- `/admin/memory`: read-only view of recent `conversation_summaries`, `memories`, and `model_usage_logs`.
- **Implemented:** `src/app/admin/layout.tsx` provides shared layout: auth check (ADMIN_SECRET), sticky header with nav (Overview, Models & routing, Skills, Memory & logs). Child pages render content only; no duplicate auth or back links.
- Editing (models/skills, toggles) is still via SQL / Supabase dashboard for now.

## Conventions for maintainability

- **Structure:** Orchestrator in `apps/orchestrator`; Next.js in `src/`; Supabase migrations in `supabase/migrations`. Group by domain (e.g. skills, chat, admin).
- **Restructuring:** Prefer incremental refactors; extract shared types, admin layout, or `lib/` helpers as needed. Document in context.md.
- **Proactive messaging:** Minimal data model (no new tables); use `messages.meta.proactive` to mark proactive messages. Scheduler: Supabase pg_cron + Edge Function **or** Cloudflare Cron + Worker (see RESEARCH_AND_DESIGN.md).
