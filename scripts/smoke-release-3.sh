#!/usr/bin/env bash
# Potaeto Release 3 Ubiquitous Smoke & Acceptance Verification
#
# Validates:
#   1. Live Core HTTP endpoints (Health, Pair, Models Usage accounting)
#   2. End-to-End Acceptance Scenarios (Desktop contracts, Sync conflicts, Usage API, Backup/Restore drill)
#   3. Full Pytest Backend Test Suite (391 tests)
#   4. Full Vitest Frontend Test Suite (121 tests across 19 suites)
#   5. Tauri v2 Desktop & Rust Cargo Check
#   6. Production Static Export Build & Verification
#   7. PII & Open-Source Hygiene Scan
#
# Usage:
#   bash scripts/smoke-release-3.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/apps/orchestrator"

echo "=== [Potaeto Release 3] Starting Ubiquitous Smoke & Acceptance Verification ==="

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

TMP="$(mktemp -d "${TMPDIR:-/tmp}/potaeto-smoke-r3.XXXXXX")"
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

# Check Models Usage endpoint (Release 3 Feature)
curl -fsS "$BASE/v1/models/usage" -H "$AUTH" -o "$TMP/usage.json"
"$PY" -c '
import json, sys
data = json.load(open("'"$TMP/usage.json"'"))
assert "total_tokens_in" in data and "by_provider" in data and "by_model" in data, "Malformed usage response"
'
echo "  [PASS] GET /v1/models/usage -> 200 OK (valid schema)"

# -----------------------------------------------------------------------------
# 2. Release 3 Acceptance Scenarios Suite
# -----------------------------------------------------------------------------
echo "--> 2. Running Release 3 Acceptance Scenarios..."
(
	cd "$CORE"
	uv run --extra dev pytest tests/test_acceptance_release_3.py -v
)
echo "  [PASS] Release 3 Acceptance Scenarios passed."

# -----------------------------------------------------------------------------
# 3. Full Backend Pytest Suite
# -----------------------------------------------------------------------------
echo "--> 3. Running Full Backend Pytest Suite..."
(
	cd "$CORE"
	uv run --extra dev pytest
)
echo "  [PASS] Full Pytest suite passed (391 tests)."

# -----------------------------------------------------------------------------
# 4. Full Frontend Vitest Suite
# -----------------------------------------------------------------------------
echo "--> 4. Running Full Frontend Vitest Suite..."
(
	cd "$ROOT"
	npm test
)
echo "  [PASS] Full Vitest suite passed (121 tests across 19 suites)."

# -----------------------------------------------------------------------------
# 5. Tauri Desktop Cargo Check
# -----------------------------------------------------------------------------
echo "--> 5. Checking Tauri Desktop Rust Workspace..."
(
	cd "$ROOT"
	cargo check --manifest-path src-tauri/Cargo.toml
)
echo "  [PASS] Tauri Cargo check passed."

# -----------------------------------------------------------------------------
# 6. Production Static Export Build
# -----------------------------------------------------------------------------
echo "--> 6. Building Next.js Static Export..."
(
	cd "$ROOT"
	npm run build
	node scripts/check-static-export.mjs
)
echo "  [PASS] Static export build passed."

# -----------------------------------------------------------------------------
# 7. PII & Secret Hygiene Scan
# -----------------------------------------------------------------------------
echo "--> 7. Running PII & OSS Compliance Scan..."
(
	cd "$ROOT"
	bash scripts/check-pii.sh
)
echo "  [PASS] PII scan passed (clean)."

echo ""
echo "=== [Potaeto Release 3] ALL VERIFICATIONS PASSED SUCCESSFULLY ==="
