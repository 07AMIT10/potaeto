# Potaeto – Project Context

**Last updated:** After initial MVP implementation (first full implementation pass).

## What is Potaeto

Potaeto is a user-friendly, multiplatform MVP app where users:
1. Log in (magic link or OAuth via Supabase).
2. Describe **WHO and WHAT** they want to build (character/persona) via **text or voice**.
3. Interact via **chatbot** or **script-based avatar** (script + TTS + simple avatar).
4. Generate **image** and **text** (MVP); video and music planned later.
5. **Export/share** via entity profile links and direct content links.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React, Tailwind CSS, TypeScript.
- **Backend / BaaS:** Supabase (Auth, Postgres, Storage). All Gemini calls go through Next.js API routes (server-side).
- **AI:** Google Gemini API (text, image, TTS). Default text model: `gemini-2.5-flash`. Override with env: `GEMINI_MODEL`, `GEMINI_IMAGE_MODEL`, `GEMINI_TTS_MODEL`. Optional: user-provided Gemini API key in profile.
- **Voice input:** `react-speech-recognition` (Web Speech API) for “describe WHO/WHAT” by voice.
- **PWA:** Next.js manifest; installable web app.

## Repo Structure

```
src/
  app/
    (auth)/login/          # Login (magic link + OAuth)
    (app)/                 # Authenticated app
      onboarding/          # First-time: describe WHO/WHAT
      create/              # Edit entity, add avatar
      chat/[entityId]/     # Chat with entity
      avatar/[entityId]/   # Script-based avatar + TTS
      library/             # Generated content
      share/               # Share links
    (public)/
      u/[username]/        # Public user profile
      e/[slug]/            # Public entity profile
      c/[contentId]/       # Public content view
    api/
      auth/                # Supabase auth callback
      ai/
        parse-entity/      # POST: text/voice → WHO/WHAT JSON
        chat/              # POST: streaming chat
        script/            # POST: generate script
        tts/               # POST: text → speech
        generate/
          image/           # POST: image generation
          text/            # POST: text generation
    admin/                 # Admin dashboard (metrics)
  components/
  lib/
    supabase/              # client, server, middleware
  types/
```

## Data Model

- **profiles:** id (→ auth.users), username, avatar_url, gemini_api_key_encrypted, is_public.
- **entities:** id, user_id, name, slug, characteristics (JSONB), appearance (JSONB), persona (JSONB), skills (JSONB), attributes (JSONB), avatar_asset_url, is_public.
- **content:** id, user_id, entity_id, type (image|video|audio|text), storage_path, public_url, metadata (JSONB).

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
2. Run Supabase migrations: use **Supabase MCP** (if enabled), **Supabase CLI** (`supabase link` then `supabase db push`), or **Dashboard** SQL editor — run files in `supabase/migrations/` in order (01 → 05).
3. `npm install` then `npm run dev`.

## Admin

- Basic admin dashboard at `/admin` (protected by env or role): user count, entity count, content count, storage usage (or link to Supabase dashboard).
