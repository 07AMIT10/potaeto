# Potaeto

Create **WHO and WHAT** you want to build — describe in text or voice, then chat, generate content, and share.

## Features

- **Character creation** via text or voice description, AI-parsed into structured persona
- **Streaming chat** with your character (stays in character, remembers context)
- **Proactive messaging** — your character reaches out when you've been away
- **Script & voice** — generate scripts and play them with TTS
- **Image & text generation** — create content as or for your character
- **Skills pipeline** — extensible skill system (songwriter built-in, more via config)
- **Share** — public entity profiles and content links
- **Admin dashboard** — models, skills, memory, and usage metrics

## Stack

- **Next.js 14** (App Router), **TypeScript**, **Tailwind CSS**
- **Supabase** (Auth, Postgres, Storage, RLS)
- **Google Gemini API** (text, image, TTS — server-side only)
- **Python FastAPI** orchestrator (model routing, skills pipeline)

## Requirements

- **Node.js** >= 18.17 (>= 20 recommended)
- **Python** >= 3.11 (for the orchestrator)

## Setup

1. **Clone and install**
   ```bash
   npm install
   ```

2. **Environment**
   - Copy `.env.example` to `.env.local`
   - Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - Set `GOOGLE_GEMINI_API_KEY` (or let users add their own in profile)
   - Set `ORCHESTRATOR_URL` (default: `http://localhost:8000`)
   - Set `ADMIN_SECRET` for admin dashboard and proactive message trigger

3. **Database**
   - Create a [Supabase project](https://supabase.com/dashboard) and get URL + anon + service_role keys.
   - Apply migrations (pick one):
     - **Supabase CLI**: `npx supabase link --project-ref <your-ref>` then `npx supabase db push`.
     - **Dashboard**: In Supabase SQL Editor, run each file in `supabase/migrations/` in order (01 through 15).
   - Storage buckets `avatars` and `content` are created by migration 04 (public read for share links).

4. **Orchestrator** (optional for MVP — required for chat, skills, proactive)
   ```bash
   cd apps/orchestrator
   pip install -e .
   uvicorn app.main:app --reload
   ```

5. **Run**
   ```bash
   npm run dev
   ```

6. **Proactive messaging** (optional)
   Set up a cron job to call `POST /api/proactive/trigger` with `X-Admin-Secret: <your-secret>` header. This finds idle conversations and generates entity-initiated messages.

## Project Context

See **[context.md](./context.md)** for architecture, routes, data model, and conventions. It is the single source of context for other IDEs and agents and is updated after each iteration.

## Design

See **[RESEARCH_AND_DESIGN.md](./RESEARCH_AND_DESIGN.md)** for the design document covering skills pipeline, streaming, proactive messaging, and UI principles.

## Project Structure

```
src/                       # Next.js frontend
  app/                     # App Router pages and API routes
  components/              # Reusable React components
  lib/                     # Utilities (Supabase, Gemini, chat memory)
  types/                   # TypeScript type definitions

apps/orchestrator/         # Python FastAPI orchestrator
  app/
    main.py               # API endpoints
    config.py             # Environment config
    router/               # Model routing
    providers/            # Gemini, Groq, HuggingFace providers
    skills/               # Skills pipeline service

supabase/migrations/       # SQL migrations (15 files)
```

## Icon

Add a cute potato icon at `public/icon-192.png` and `public/icon-512.png` for the PWA manifest.
