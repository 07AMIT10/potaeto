# Potaeto

Create **WHO and WHAT** you want to build — describe in text or voice, then chat, generate content, and share.

## Stack

- **Next.js 14** (App Router), **TypeScript**, **Tailwind**
- **Supabase** (Auth, Postgres, Storage)
- **Google Gemini API** (text, image, TTS — server-side only)

## Requirements

- **Node.js** >= 18.17 (>= 20 recommended for Supabase and Gemini SDKs)

## Setup

1. **Clone and install**
   ```bash
   npm install
   ```

2. **Environment**
   - Copy `.env.example` to `.env.local`
   - Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - Set `GOOGLE_GEMINI_API_KEY` (or let users add their own in profile)

3. **Database**
   - Create a [Supabase project](https://supabase.com/dashboard) and get URL + anon + service_role keys.
   - Apply migrations (pick one):
     - **Supabase MCP**: If the Supabase MCP is enabled in Cursor, use it to run the SQL in `supabase/migrations/` in order (01 → 05), or to push migrations.
     - **Supabase CLI**: `npx supabase link --project-ref <your-ref>` then `npx supabase db push`.
     - **Dashboard**: In Supabase → SQL Editor, run each file in `supabase/migrations/` in order (01_profiles, 02_entities, 03_content, 04_storage, 05_admin).
   - Storage buckets `avatars` and `content` are created by migration 04 (public read for share links).

4. **Run**
   ```bash
   npm run dev
   ```

## Project context

See **[context.md](./context.md)** for architecture, routes, data model, and conventions. It is the single source of context for other IDEs and agents and is updated after each iteration.

## Icon

Add a cute potato icon at `public/icon-192.png` and `public/icon-512.png` for the PWA manifest.
