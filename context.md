# Potaeto – Project Context

**Last updated:** After wiring web → orchestrator for chat/summarization/parse-entity/skills, adding Groq/HF providers, routing logs, and admin dashboards.

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
- **Orchestrator:** Python FastAPI service in `apps/orchestrator` that routes between models using `models_config` (providers: Gemini, Groq, Hugging Face via InferenceClient) and logs usage to `model_usage_logs`.
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
        chat/              # POST: chat with memory + summary (delegates to orchestrator /v1/chat + /v1/summarize)
        script/            # POST: generate script
        tts/               # POST: text → speech
        generate/
          image/           # POST: image generation
          text/            # POST: text generation
      skills/
        songwriter/invoke/ # POST: invoke songwriter skill (delegates to orchestrator /v1/skills/songwriter/invoke)
      conversations/[entityId]/messages/  # GET: load persisted chat history
    admin/                 # Admin dashboard (metrics, models, skills, memory/logs)
  components/
  lib/
    supabase/              # client, server, middleware
    gemini.ts              # env-driven model config helpers
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
- `/admin/models`: read-only view of `models_config` and recent `model_usage_logs` stats (calls / errors / avg latency per model).
- `/admin/skills`: read-only view of `skills` catalog + how many entities have each skill enabled via `entity_skills`.
- `/admin/memory`: read-only view of recent `conversation_summaries`, `memories`, and raw `model_usage_logs`.
- Editing (adding models/skills, toggles, quotas) is still done via SQL / Supabase dashboard for now.
