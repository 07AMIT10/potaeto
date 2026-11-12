# Deploying Potaeto on Render — SUPERSEDED

> **Superseded.** Release 1 deploys to a self-hosted Linux host with systemd + Caddy + optional
> Cloudflare Tunnel, not Render, and uses SQLite instead of Supabase. Use
> [`deploy/README.md`](deploy/README.md). This file and `render.yaml` are kept
> only as historical context for the retired hosted deployment; do not follow
> them for a Release 1 install.

This app has **two deployable parts**:

1. **Next.js (frontend + API routes)** — Node.js web service  
2. **Orchestrator (Python FastAPI)** — Docker web service (chat, skills, summarization, model routing)

Both can be deployed on Render using the included `render.yaml` blueprint.

---

## Prerequisites

- **Supabase project** with migrations applied (see README “Database”)
- **Google Gemini API key**
- **Render account** (free tier works for both services)

---

## Option A: One-click from Blueprint (recommended)

1. **Push your repo to GitHub/GitLab** (must contain `render.yaml` at repo root).

2. **In Render Dashboard**: [New](https://dashboard.render.com/select-repo) → **Blueprint** → connect the repo. Render will detect `render.yaml` and create two services:
   - **potaeto-web** (Node)
   - **potaeto-orchestrator** (Docker)

3. **Set environment variables** for both services (Dashboard → each service → Environment):

   **potaeto-web**

   | Key | Description |
   |-----|-------------|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (API routes) |
   | `GOOGLE_GEMINI_API_KEY` | Gemini API key |
   | `ORCHESTRATOR_URL` | **Leave unset** if using blueprint link; otherwise set to `https://potaeto-orchestrator.onrender.com` (or your orchestrator URL) |
   | `ADMIN_SECRET` | Secret for `/admin` and proactive trigger |

   **potaeto-orchestrator**

   | Key | Description |
   |-----|-------------|
   | `GOOGLE_GEMINI_API_KEY` | Same Gemini key |
   | `SUPABASE_URL` | Same as `NEXT_PUBLIC_SUPABASE_URL` |
   | `SUPABASE_ANON_KEY` | Same as `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
   | `SUPABASE_SERVICE_ROLE_KEY` | **Required** so the orchestrator can read `models_config` (RLS is admin-only) |

  Optional (orchestrator): `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `SAMBANOVA_API_KEY`, `OPENROUTER_API_KEY`, `HF_API_KEY`, `HF_INFERENCE_BASE_URL`, `ENABLED_PROVIDERS`.
  Example:
  - `ENABLED_PROVIDERS=gemini,groq,cerebras,sambanova,openrouter` (recommended baseline)
  - `ENABLED_PROVIDERS=gemini,groq,cerebras,sambanova,openrouter,huggingface` (if HF endpoint is configured)

4. **Deploy**: Save env and let Render build and deploy. The web service gets `ORCHESTRATOR_URL` from the orchestrator’s URL when the blueprint link is used.

5. **Root directory**: If your repo root is the **parent** of this app (e.g. repo is `potaeto` and this app is in `Anveshak/`), set **Root Directory** for **potaeto-web** to `Anveshak` (or the folder that contains `package.json`). The orchestrator uses `dockerContext: apps/orchestrator`, so it is always built from that path.

---

## Option B: Manual service creation

### 1. Orchestrator (Docker)

- **New** → **Web Service** → connect repo.
- **Runtime**: Docker.
- **Dockerfile path**: `apps/orchestrator/Dockerfile`
- **Docker context**: `apps/orchestrator`
- **Health check path**: `/v1/health`
- **Env**: `GOOGLE_GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (required for `models_config`). For scheduled jobs, also set `POTAETO_SCHEDULER_ENABLED=1`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_CHAT_IDS`.

### 2. Next.js (Node)

- **New** → **Web Service** → same repo.
- **Runtime**: Node.
- **Build**: `npm install && npm run build`
- **Start**: `npm run start`
- **Root Directory**: Leave blank if `package.json` is at repo root; otherwise set to the directory that contains `package.json`.
- **Env**: All vars from the table above for **potaeto-web**, and set `ORCHESTRATOR_URL` to the orchestrator’s Render URL (e.g. `https://potaeto-orchestrator.onrender.com`).

---

## Post-deploy

- **Scheduled jobs**: create jobs with `POST /v1/jobs` (device auth required). The
  orchestrator executes them only when `POTAETO_SCHEDULER_ENABLED=1`; `notify`
  steps are delivered to every comma-separated `TELEGRAM_ALLOWED_CHAT_IDS`
  entry, which also requires `TELEGRAM_BOT_TOKEN`. Without the flag, jobs are
  stored but never fire. The runner polls every 30 seconds and Telegram messages
  are split at 4096 UTF-16 units.
- **Proactive messaging**: Call `POST https://<your-web-url>/api/proactive/trigger` with header `X-Admin-Secret: <ADMIN_SECRET>` from a cron (e.g. Render Cron Job, or external scheduler). See README “Proactive messaging”.
- **Admin**: Release 1 has **no default admin credentials** and no admin UI.
  `/v1/admin/*` is fail-closed: it returns 503 unless `ADMIN_SECRET` is set and
  the caller supplies the matching header.

---

## Important details from the codebase

- **Orchestrator** must use **`SUPABASE_SERVICE_ROLE_KEY`** (not only anon key) because `models_config` is protected by RLS (admin-only). The orchestrator reads model config and writes `model_usage_logs`; without the service role key it cannot read `models_config`.
- **Next.js** uses `ORCHESTRATOR_URL` for chat, parse-entity, skills, proactive, and admin health/cache-invalidate. If the orchestrator URL is wrong or the service is sleeping (free tier), those features will fail until it wakes.
- **Free tier**: Both services may spin down after inactivity; first request after idle can be slow (cold start). Orchestrator is single-worker and tuned for 512MB.
