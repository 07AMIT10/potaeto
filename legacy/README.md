# Retired Next.js server surface

These files are the pre-Release-1 Next.js server routes (Supabase/Gemini era). They
were moved here during the Next.js 16 + static-export upgrade because a static
export cannot host:

- request-dependent Route Handlers (`app/api/**`),
- middleware/proxy (`middleware.ts`),
- pages that call `cookies()` or server-only Supabase clients at build time,
- dynamic routes whose IDs are not known at build time.

They are **not built, served, or deployed**. They are kept as reference for the
Release 1 client work (Tasks 2-9), which replaces them with the FastAPI core and
the `CoreClient` + IndexedDB PWA. Delete this directory once those ports land.
