#!/usr/bin/env bash
# Potaeto Release 2 Comprehensive Integration and Smoke Verification
#
# Validates:
#   1. Live Core HTTP endpoints (Health, Pair, Approvals, Hardware Telemetry, Tool Registry)
#   2. End-to-End Acceptance Scenarios (Research + LED audit, 7 Memory Evals, Voice, Workflow lease)
#   3. Full Pytest Backend Test Suite (379+ tests)
#   4. Full Vitest Frontend Suite (47+ tests)
#   5. Production Static Export Build & Verification
#   6. PII & Open-Source Hygiene Scan
#
# Usage:
#   bash scripts/smoke-release-2.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/apps/orchestrator"

echo "=== [Potaeto Release 2] Starting Full Smoke & Acceptance Verification ==="

# -----------------------------------------------------------------------------
# 1. Live Ephemeral HTTP Core Smoke Check
# -----------------------------------------------------------------------------
echo "--> 1. Running live ephemeral core server checks..."

PY="${POTAETO_PYTHON:-$CORE/.venv/bin/python}"
if [[ ! -x "$PY" ]]; then
	PY="$(command -v python3 || true)"
fi
if [[ -z "$PY" || ! -x "$PY" ]]; then
	echo "smoke: python3 is required" >&2
	exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
	echo "smoke: curl is required" >&2
	exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/potaeto-smoke-r2.XXXXXX")"
SERVER_PID=""
cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

PORT="$("$PY" - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
BASE="http://127.0.0.1:$PORT"

export POTAETO_DB_PATH="$TMP/smoke.db"
export POTAETO_MODEL="smoke-model"
export POTAETO_SMOKE_PROVIDER=1
export POTAETO_SCHEDULER_ENABLED=0
export OPENCODE_API_KEY="" OPENCODE_GO_API_KEY="" OPENROUTER_API_KEY=""
export TELEGRAM_BOT_TOKEN="" TELEGRAM_ALLOWED_CHAT_IDS=""

(
	cd "$CORE"
	exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning
) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

HEALTHY=0
for _ in $(seq 1 300); do
	if curl -fsS "$BASE/v1/health" -o "$TMP/health.json" 2>/dev/null; then
		HEALTHY=1
		break
	fi
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "Server failed to start. Logs:" >&2
		cat "$TMP/server.log" >&2
		exit 1
	fi
	sleep 0.05
done
[[ "$HEALTHY" == 1 ]] || { echo "Health check failed" >&2; exit 1; }
echo "  [PASS] GET /v1/health -> ok"

# Pair device for authenticated calls
CODE="$(cd "$CORE" && "$PY" -m app.cli pair --user u_smoke)"
TOKEN="$(curl -fsS -X POST "$BASE/v1/auth/pair" \
	-H 'Content-Type: application/json' \
	-d "{\"code\": \"$CODE\", \"device_name\": \"smoke-device\"}" | "$PY" -c 'import sys, json; print(json.load(sys.stdin)["token"])')"
AUTH="Authorization: Bearer $TOKEN"
echo "  [PASS] POST /v1/auth/pair -> token acquired"

# Check Approvals pending endpoint
curl -fsS "$BASE/v1/approvals/pending" -H "$AUTH" -o "$TMP/approvals.json"
echo "  [PASS] GET /v1/approvals/pending -> 200 OK"

# Check Hardware Telemetry endpoint
curl -fsS "$BASE/v1/hardware/telemetry" -o "$TMP/telemetry.json"
echo "  [PASS] GET /v1/hardware/telemetry -> 200 OK"

# Tool registration check in loop
(
	cd "$CORE"
	"$PY" -c '
from app.agent.loop import AgentLoop
from app.db.connection import connect_db, run_migrations
conn = connect_db(":memory:")
run_migrations(conn)
loop = AgentLoop(conn, None)
tools = set(loop.tools.keys())
required = {"run_command", "lens_research", "arduino_led", "memory_search", "system_health"}
missing = required - tools
if missing:
    raise SystemExit(f"Missing required tools in AgentLoop: {missing}")
print(f"  [PASS] Tool registration check -> verified {len(tools)} tools registered (including {required})")
'
)

# -----------------------------------------------------------------------------
# 2. Acceptance Scenarios Suite
# -----------------------------------------------------------------------------
echo "--> 2. Running Release 2 Acceptance Scenarios..."
(
	cd "$CORE"
	uv run --extra dev pytest tests/test_acceptance_release_2.py -v
)
echo "  [PASS] Release 2 Acceptance Scenarios passed."

# -----------------------------------------------------------------------------
# 3. Full Backend Pytest Suite
# -----------------------------------------------------------------------------
echo "--> 3. Running Full Backend Pytest Suite..."
(
	cd "$CORE"
	uv run --extra dev pytest
)
echo "  [PASS] Full Pytest suite passed."

# -----------------------------------------------------------------------------
# 4. Full Frontend Vitest Suite
# -----------------------------------------------------------------------------
echo "--> 4. Running Full Frontend Vitest Suite..."
(
	cd "$ROOT"
	npm test
)
echo "  [PASS] Full Vitest suite passed."

# -----------------------------------------------------------------------------
# 5. Production Static Export Build
# -----------------------------------------------------------------------------
echo "--> 5. Building Next.js Static Export..."
(
	cd "$ROOT"
	npm run build
	node scripts/check-static-export.mjs
)
echo "  [PASS] Static export build passed."

# -----------------------------------------------------------------------------
# 6. PII & Secret Hygiene Scan
# -----------------------------------------------------------------------------
echo "--> 6. Running PII & OSS Compliance Scan..."
(
	cd "$ROOT"
	bash scripts/check-pii.sh
)
echo "  [PASS] PII scan passed (clean)."

echo ""
echo "=== [Potaeto Release 2] ALL VERIFICATIONS PASSED SUCCESSFULLY ==="
