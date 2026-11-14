# Deploying Potaeto Release 1

Release 2 & 3 run on a self-hosted Linux host (`agent-host`) as three processes:

```
phone / desktop / PWA
        │  HTTPS (optional remote)
        ▼
Cloudflare Access ── Cloudflare Tunnel ── Caddy :8080 ┬── potaeto-core 127.0.0.1:8010 ── SQLite + agent-memory
                                              │       └── potaeto-voice 127.0.0.1:8012 ── Piper + Whisper models
                                              └── /opt/potaeto/out
```

- **`potaeto-core`** is a single uvicorn process bound to **`127.0.0.1:8010`**. It owns SQLite, providers, the agent loop, scheduler, Telegram, and memory indexing.
- **`potaeto-voice`** is an isolated voice subsystem bound to **`127.0.0.1:8012`** (`MemoryMax=1G`, `Nice=10`). It owns local offline Piper TTS and Whisper STT inference.
- **Caddy** listens on **`:8080`**, serves the static Next.js export from `/opt/potaeto/out`, proxies `/v1/voice/*` to `potaeto-voice:8012`, and proxies `/v1/*` to `potaeto-core:8010`.
- **Cloudflare Tunnel + Access** are the optional remote path. The tunnel is routing, **not authentication**; Access is the remote auth layer, and device pairing remains enforced behind it.

### Ports

On the target host (`agent-host`), **port `8000` is already taken by another
service**, so Potaeto's core uses **`8010`**, the voice worker uses **`8012`**, and Caddy listens on **`8080`**.

## Layout

| Path | Purpose |
|---|---|
| `/opt/potaeto/apps/orchestrator` | Python core (`systemd` `WorkingDirectory`) |
| `/opt/potaeto/apps/orchestrator/.venv` | Core virtualenv (unit's `ExecStart`) |
| `/opt/potaeto/out` | Built static PWA (`next build`, `output: 'export'`) |
| `/opt/potaeto/data` | SQLite database (writable by the service) |
| `/opt/potaeto/data/models` | Offline Piper ONNX and Whisper STT models |
| `/opt/potaeto/bin` | Self-contained user binaries (caddy, piper, whisper-cli, ffmpeg) |
| `/opt/potaeto/.env` | Environment file, mode `0600`, owned by `potaeto` |
| `/opt/potaeto/deploy` | Unit, Caddyfile, and this document |
| `/home/operator/agent-memory` | Canonical markdown memory tree, versioned with git |

## 1. Install the service user and ACLs

```bash
sudo useradd --system --user-group --home /opt/potaeto --shell /usr/sbin/nologin potaeto
sudo install -d -o potaeto -g potaeto /opt/potaeto
sudo install -d -o potaeto -g potaeto /opt/potaeto/apps/orchestrator
sudo usermod -aG dialout potaeto          # future Arduino serial bridge
```

The core **reads and indexes** the agent-memory tree; markdown stays canonical
and the core never rewrites those files (writes go through the `agent-memory`
CLI). `/home/operator` is not traversable by other users, so grant the service user
traverse-only access to the parent and read/write access to the tree (the tree
stays owned by the operator account):

```bash
sudo setfacl -m u:potaeto:--x /home/operator
sudo setfacl -R -m u:potaeto:rwX /home/operator/agent-memory
sudo setfacl -R -d -m u:potaeto:rwX /home/operator/agent-memory
```

Replace `operator` with the human account that owns the memory tree. Without the
`--x` on `/home/operator`, `potaeto` gets `EACCES` before it can reach
`agent-memory`, even though the child ACL is correct.

## 2. Copy and build the app

Build the static client where Node is available, then copy the app tree. This
step is **safe to re-run**: `--delete` makes redeploys exact, but every path
that holds production state is excluded (`data/`, `backups/`, `.env`, `.venv`,
and local-only trees). Excluded destination entries are not removed by
`rsync --delete` (do not add `--delete-excluded`).

The build is same-origin: leave `NEXT_PUBLIC_CORE_URL` **empty** so the PWA
calls relative `/v1/*` paths. `next.config.mjs` fails a production build if the
variable is set, because Next inlines `NEXT_PUBLIC_*` into the browser bundle
(a stray `.env.local` would bake the dev core URL `http://localhost:8000` into
every device).

```bash
npm ci
NEXT_PUBLIC_CORE_URL= npm run build        # produces ./out; must stay empty
sudo rsync -a --delete \
  --exclude .git --exclude .next --exclude node_modules --exclude .venv \
  --exclude .env --exclude .env.local \
  --exclude data --exclude backups --exclude exports \
  --exclude .superpowers --exclude legacy --exclude supabase \
  --exclude __pycache__ --exclude .pytest_cache \
  --exclude .mypy_cache --exclude .ruff_cache \
  ./ /opt/potaeto/

# Create writable state only after the sync, so --delete can never remove it.
sudo install -d -o potaeto -g potaeto /opt/potaeto/data /opt/potaeto/backups
```

Create the core virtualenv on the target (`.venv` is excluded from future
syncs, so dependency installs survive redeploys):

```bash
sudo python3 -m venv /opt/potaeto/apps/orchestrator/.venv
sudo /opt/potaeto/apps/orchestrator/.venv/bin/pip install -e /opt/potaeto/apps/orchestrator
```

The unit expects exactly `/opt/potaeto/apps/orchestrator/.venv/bin/uvicorn`.

## 3. Configure the environment

```bash
sudo install -m 600 -o potaeto -g potaeto .env.example /opt/potaeto/.env
sudo -u potaeto vi /opt/potaeto/.env
```

At minimum set:

```dotenv
POTAETO_DB_PATH=/opt/potaeto/data/potaeto.db
POTAETO_MODEL=<model id>
# Caps provider output; OpenRouter returns 402 when max_tokens is omitted.
POTAETO_MAX_OUTPUT_TOKENS=4096
POTAETO_MEMORY_SCOPE=project:Anveshak
POTAETO_CONTEXT_CEILING=32000
POTAETO_CONTEXT_FLOOR=4000
POTAETO_MEMORY_DIR=/home/operator/agent-memory
OPENCODE_API_KEY=<opencode-go key>        # or OPENROUTER_API_KEY
```

Optional: `POTAETO_PROVIDER=opencode_go` (preferred provider; empty uses
catalog order), `POTAETO_MAX_OUTPUT_TOKENS=4096` (caps provider output; when
omitted, OpenRouter uses the model maximum and may return a 402),
`POTAETO_MEMORY_SCOPE=project:Anveshak` (retrieval scope; `global` means global
only), `POTAETO_CONTEXT_CEILING=32000` and `POTAETO_CONTEXT_FLOOR=4000` (the
per-turn context budget is derived from the model's catalog context length and
clamped into this range), a second provider key as fallback,
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_IDS` (both required, fail-closed),
`POTAETO_SCHEDULER_ENABLED=1`, `RATE_LIMIT_PAIR_PER_MIN`,
`RATE_LIMIT_CHAT_PER_MIN`.

`POTAETO_COOKIE_SECURE` defaults to **1** and must stay on in production (the
device cookie is then `Secure`). Set `POTAETO_COOKIE_SECURE=0` **only** for
local development over plain `http://localhost`; over the tunnel/HTTPS it must
be `1`.

`NEXT_PUBLIC_CORE_URL` must stay **empty** for production builds: the PWA then
calls relative `/v1/*` paths and Caddy serves the API same-origin. For
`npm run dev` on the dev workstation (`dev-host`; port `8000` is free), set
`NEXT_PUBLIC_CORE_URL=http://localhost:8000` in Next's `.env.local`, and export
`POTAETO_COOKIE_SECURE=0` for the core process (in its shell or
`apps/orchestrator/.env`) so the dev cookie works over plain HTTP. This dev
value — like the dev `ORCHESTRATOR_URL` — is one of the only places `8000`
remains: production on `agent-host` uses `8010`.

Never put provider, Telegram, or Supabase service-role keys in
`NEXT_PUBLIC_*` variables: Next.js inlines those into the browser bundle.

With `POTAETO_MEMORY_DIR` set, the core indexes the markdown tree once at
startup in a background thread. To reindex on demand (after editing notes, or
from a cron entry) run:

```bash
cd /opt/potaeto/apps/orchestrator
sudo -u potaeto env POTAETO_DB_PATH=/opt/potaeto/data/potaeto.db \
  .venv/bin/python -m app.cli index-memory --root /home/operator/agent-memory
```

## 4. Install and start the core

```bash
sudo cp deploy/potaeto-core.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/potaeto-core.service
sudo systemctl daemon-reload
sudo systemctl enable --now potaeto-core
curl -fsS http://127.0.0.1:8010/v1/health
```

Hardening in the unit:

| Setting | Effect |
|---|---|
| `User=potaeto` / `Group=potaeto` | Unprivileged service identity |
| `NoNewPrivileges=true` | No setuid/setgid escalation |
| `PrivateTmp=true` | Private `/tmp` namespace |
| `ProtectSystem=strict` | Whole filesystem read-only to the service |
| `ReadWritePaths=/opt/potaeto/data /home/operator/agent-memory` | Only these paths are writable |
| `MemoryMax=512M` / `CPUQuota=200%` / `Nice=5` | Leaves the rest of the 8 GB box headroom |
| `SupplementaryGroups=dialout` / `DeviceAllow=/dev/ttyACM0 rw` | Future serial bridge only |
| `Restart=on-failure` | Recovers from crashes |

Logs: `journalctl -u potaeto-core -f`.

## 5. Install Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -I http://127.0.0.1:8080/
```

`deploy/Caddyfile`:

- proxies **`/v1/*`** to `127.0.0.1:8010`, preserving the path;
- serves `/opt/potaeto/out` with fallbacks `{path}`, `{path}.html`,
  `{path}/index.html`, then `/index.html` (static export + client routing);
- forwards all request headers unchanged, so **`CF-Connecting-IP` is preserved**;
  Caddy appends the immediate peer to **`X-Forwarded-For`** itself. Do not
  overwrite either header.

The core must stay loopback-bound. `app/api/rate_limit.py` trusts forwarded IP
headers only when the TCP peer is loopback, so Caddy is the only trusted proxy.
If the core is ever bound to a non-loopback address, a remote caller could spoof
those headers and evade rate limiting.

### Remote access (optional)

```bash
cloudflared tunnel login
cloudflared tunnel create potaeto
cloudflared tunnel route dns potaeto potaeto.example.com
# /etc/cloudflared/config.yml
#   tunnel: <uuid>
#   credentials-file: /etc/cloudflared/<uuid>.json
#   ingress:
#     - hostname: potaeto.example.com
#       service: http://localhost:8080
#     - service: http_status:404
sudo cloudflared service install
```

Then create a **Cloudflare Access** application for the hostname with an
allow policy for the operator's email/identity. Tunnel alone is not
authentication.

**Rate-limit trust caveat:** the limiter keys on the first `X-Forwarded-For`
entry, falling back to `CF-Connecting-IP`. With a tunnel in front, the chain may
contain a cloudflared/edge hop before the end-user address, so remote requests
can share one bucket (Release 1 has a single user, so this is acceptable). If
per-client tunnel limits matter later, prefer `CF-Connecting-IP` in the limiter
or configure the tunnel to pass the true client address. Direct LAN clients are
keyed by their LAN address.

## 6. Pair a device

There is deliberately **no public pairing-code endpoint**. Create a code on the
server with the dev CLI:

```bash
cd /opt/potaeto/apps/orchestrator
sudo -u potaeto env POTAETO_DB_PATH=/opt/potaeto/data/potaeto.db \
  .venv/bin/python -m app.cli pair --user u_local
```

The code is single-use, expires after 300 seconds, and is printed only to
stdout. Open the PWA's pairing screen (`/pair`), enter the code and a device
name, and the core sets the HttpOnly device cookie. Use `--json` for a
machine-readable object or `--ttl` to change the lifetime. Old `/login` and
`/onboarding` links redirect to `/pair`.

The model picker in `/chat` reads the authenticated `GET /v1/models` catalog and
persists the choice through `POST /v1/models/active`; no provider key is ever
included in that payload.

## 7. Backups

`scripts/backup.sh` uses SQLite's **online backup API**, never a raw copy of a
live WAL database. It writes a gzipped daily snapshot, refreshes one snapshot per
ISO week, verifies gzip + `PRAGMA integrity_check`, and keeps **7 daily + 4
weekly** files.

```bash
sudo -u potaeto env \
  POTAETO_DB_PATH=/opt/potaeto/data/potaeto.db \
  POTAETO_BACKUP_DIR=/opt/potaeto/backups \
  POTAETO_MEMORY_DIR=/home/operator/agent-memory \
  /opt/potaeto/scripts/backup.sh
```

Suggested daily cron job (03:15). Install it as the service user so the backup
files and lock stay owned by `potaeto`:

```bash
sudo install -d -o potaeto -g potaeto /opt/potaeto/backups
sudo crontab -u potaeto -e
```

```cron
POTAETO_DB_PATH=/opt/potaeto/data/potaeto.db
POTAETO_BACKUP_DIR=/opt/potaeto/backups
POTAETO_MEMORY_DIR=/home/operator/agent-memory
15 3 * * * /opt/potaeto/scripts/backup.sh >> /opt/potaeto/backups/backup.log 2>&1
```

If you run it from root's crontab instead, set the same variables inline before
the command and create `/opt/potaeto/backups` with the ownership you want.

If `~/agent-memory` is a git repository, the script commits local changes with
a timestamp; it **never pushes**. The backup account needs the `/home/operator`
traverse ACL from step 1 (`setfacl -m u:<user>:--x /home/operator`) plus read/write
access to the tree; without it the script cannot enter `agent-memory`. Give the
service user a git identity if it will run the backup:

```bash
sudo -u potaeto git -C /home/operator/agent-memory config user.name "Potaeto Backup"
sudo -u potaeto git -C /home/operator/agent-memory config user.email "potaeto@localhost"
```

Add a private remote and a separate push job if off-box copies are required.

`sqlite3` is preferred when installed; if it is absent the script falls back to
Python's `sqlite3.Connection.backup()`, which uses the same online-backup API.
Keep backups on a different filesystem/disk from `/opt/potaeto/data` when
possible.

### Restore test

```bash
LATEST="$(ls -1t /opt/potaeto/backups/daily/*.db.gz | head -1)"
gunzip -c "$LATEST" > /tmp/potaeto-restore.db
sqlite3 /tmp/potaeto-restore.db 'PRAGMA integrity_check;'   # -> ok
sudo systemctl stop potaeto-core
sudo rm -f /opt/potaeto/data/potaeto.db /opt/potaeto/data/potaeto.db-wal /opt/potaeto/data/potaeto.db-shm
sudo install -o potaeto -g potaeto -m 600 /tmp/potaeto-restore.db /opt/potaeto/data/potaeto.db
sudo systemctl start potaeto-core
curl -fsS http://127.0.0.1:8010/v1/health
```

Run a restore rehearsal after the first real backup and after schema migrations.

## 8. One-time Supabase export

`scripts/export_supabase.py` is **read-only**: it only issues GET requests and
exports `entities`, `conversations`, `messages`, `memories`, and
`conversation_summaries` to JSON with a manifest. It reads
`SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, and
never prints the key.

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...       # keep out of shell history/CI logs

python3 scripts/export_supabase.py --dry-run
python3 scripts/export_supabase.py         # exports/supabase-<timestamp>/
```

Offline rehearsal (no credentials, no network):

```bash
python3 scripts/export_supabase.py --dry-run \
  --fixture scripts/fixtures/supabase_export_fixture.json
```

Keep the exported directory until the SQLite migration and a restore test have
both been verified.

## 9. Smoke test

```bash
bash scripts/smoke.sh
```

The script uses a temporary database, an ephemeral port, and a temporary
uvicorn process; it never touches `/opt/potaeto` or the running service. It
checks:

1. `GET /v1/health` → `status: ok`
2. pairing code from `python -m app.cli pair`, exchanged at `/v1/auth/pair`
3. `POST /v1/sync/push` → one `applied` result
4. `GET /v1/sync?after_seq=0` contains the pushed message
5. `POST /v1/chat/stream` → SSE `token` + `done` events

The chat turn uses the deterministic offline provider enabled by
`POTAETO_SMOKE_PROVIDER=1`. That switch is test-only and must never be set in
`/opt/potaeto/.env`; leave it unset in production.

### Resource evidence (24 h)

`scripts/health-snapshot.sh` appends one line with process RSS, cgroup memory,
a 1-second CPU sample, CPU temperature, free RAM, and load. Run it from cron or
a systemd timer for the acceptance window:

```cron
POTAETO_HEALTH_LOG=/opt/potaeto/health.log
*/5 * * * * /opt/potaeto/scripts/health-snapshot.sh potaeto-core >>/opt/potaeto/backups/health-cron.log 2>&1
```

Keep `/opt/potaeto/health.log` as the evidence for **RSS ≤ 250 MB**, **idle CPU
≤ 5 %**, and no thermal warnings over 24 h (spec §7.12).

## 10. Validating these artifacts

```bash
systemd-analyze verify deploy/potaeto-core.service
caddy validate --config deploy/Caddyfile
bash scripts/smoke.sh
python3 scripts/export_supabase.py --dry-run \
  --fixture scripts/fixtures/supabase_export_fixture.json
```

`systemd-analyze verify` checks the unit's production `ExecStart` path, so it
only passes on a host where `/opt/potaeto/apps/orchestrator/.venv/bin/uvicorn`
exists. `caddy` and `sqlite3` are not installed on every developer workstation;
the scripts degrade gracefully (Python backup fallback) and the Caddy check is
run on the target host.
