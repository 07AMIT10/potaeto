#!/usr/bin/env bash
# End-to-end smoke test for the Potaeto core.
#
# It creates a throwaway SQLite database and an ephemeral port, starts a real
# uvicorn process, and checks health, pairing, sync, and a streamed chat turn.
# Production data and the running service are never touched. The chat check uses
# the offline provider gated by POTAETO_SMOKE_PROVIDER=1, so no model API key or
# network access is required.
#
# Usage:
#   bash scripts/smoke.sh
#
# Requires: bash, curl, python3 (or apps/orchestrator/.venv). Exits non-zero on
# the first failed check and prints the temporary server log.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/apps/orchestrator"

PY="${POTAETO_PYTHON:-$CORE/.venv/bin/python}"
if [[ ! -x "$PY" ]]; then
	PY="$(command -v python3 || true)"
fi
if [[ -z "$PY" || ! -x "$PY" ]]; then
	echo "smoke: python3 is required (or set POTAETO_PYTHON)" >&2
	exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
	echo "smoke: curl is required" >&2
	exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/potaeto-smoke.XXXXXX")"
SERVER_PID=""
cleanup() {
	if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
	echo "smoke: FAIL: $*" >&2
	if [[ -s "$TMP/server.log" ]]; then
		echo "--- server log ---" >&2
		cat "$TMP/server.log" >&2
	fi
	exit 1
}

json_get() {
	# json_get FILE dotted.path[0] -> value
	"$PY" - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    if part.endswith("]"):
        name, index = part[:-1].split("[", 1)
        value = value[name][int(index)]
    else:
        value = value[part]
print(value)
PY
}

PORT="$("$PY" - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)"
BASE="http://127.0.0.1:$PORT"

# Isolate the run from production and from any real provider credentials.
# Set the keys empty rather than unsetting them: app.config's load_dotenv()
# fills missing variables from an upwards-discovered .env (e.g. ~/.env) and
# would otherwise register a real provider during the smoke test.
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

# 1. Health: wait for uvicorn, then require status=ok.
HEALTHY=0
for _ in $(seq 1 300); do
	if curl -fsS "$BASE/v1/health" -o "$TMP/health.json" 2>/dev/null; then
		HEALTHY=1
		break
	fi
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		fail "server exited before becoming healthy"
	fi
	sleep 0.1
done
[[ "$HEALTHY" == 1 ]] || fail "health endpoint did not become ready"
[[ "$(json_get "$TMP/health.json" status)" == "ok" ]] || fail "health status is not ok"
echo "ok  health"

# 2. Pairing: create a code with the dev CLI (no public endpoint), exchange it.
CODE="$(cd "$CORE" && "$PY" -m app.cli pair --user u_local)"
[[ -n "$CODE" ]] || fail "CLI returned an empty pairing code"
export SMOKE_CODE="$CODE"
"$PY" - >"$TMP/pair-request.json" <<'PY'
import json
import os

print(json.dumps({"code": os.environ["SMOKE_CODE"], "device_name": "smoke"}))
PY
unset SMOKE_CODE CODE
curl -fsS -X POST "$BASE/v1/auth/pair" \
	-H 'Content-Type: application/json' \
	--data-binary @"$TMP/pair-request.json" \
	-o "$TMP/pair.json" || fail "pairing exchange failed"
TOKEN="$(json_get "$TMP/pair.json" token)"
[[ -n "$TOKEN" ]] || fail "pairing exchange returned no token"
AUTH="Authorization: Bearer $TOKEN"
echo "ok  pairing"

# 3. Sync push: append one message and require status=applied.
MSG_ID="m_smoke_$(date -u +%Y%m%dT%H%M%S)_$$"
"$PY" - "$MSG_ID" >"$TMP/push-request.json" <<'PY'
import json
import sys

message_id = sys.argv[1]
print(
    json.dumps(
        {
            "operations": [
                {
                    "idempotency_key": f"smoke-{message_id}",
                    "entity_type": "message",
                    "entity_id": message_id,
                    "base_rev": 0,
                    "payload": {
                        "role": "user",
                        "content": "smoke sync push",
                        "channel": "app",
                    },
                }
            ]
        }
    )
)
PY
curl -fsS -X POST "$BASE/v1/sync/push" \
	-H "$AUTH" -H 'Content-Type: application/json' \
	--data-binary @"$TMP/push-request.json" \
	-o "$TMP/push.json" || fail "sync push failed"
[[ "$(json_get "$TMP/push.json" results[0].status)" == "applied" ]] || fail "push was not applied"
echo "ok  sync push"

# 4. Sync pull: the pushed message must be in the change log.
curl -fsS "$BASE/v1/sync?after_seq=0" -H "$AUTH" -o "$TMP/sync.json" || fail "sync pull failed"
"$PY" - "$TMP/sync.json" "$MSG_ID" <<'PY' || fail "pushed message missing from sync pull"
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    changes = json.load(handle)["changes"]
if not any(change["entity_id"] == sys.argv[2] for change in changes):
    raise SystemExit(f"message {sys.argv[2]} not present")
PY
echo "ok  sync pull"

# 5. Chat stream: require an SSE token and a done event from the fake provider.
curl -fsS "$BASE/v1/chat/conversation" -H "$AUTH" -o "$TMP/conversation.json" || fail "conversation lookup failed"
CONVERSATION_ID="$(json_get "$TMP/conversation.json" id)"
"$PY" - "$CONVERSATION_ID" >"$TMP/chat-request.json" <<'PY'
import json
import sys

print(json.dumps({"conversation_id": sys.argv[1], "message": "smoke chat"}))
PY
HTTP_CODE="$(curl -sS -N -X POST "$BASE/v1/chat/stream" \
	-H "$AUTH" -H 'Content-Type: application/json' \
	--data-binary @"$TMP/chat-request.json" \
	-o "$TMP/chat.sse" -w '%{http_code}')"
[[ "$HTTP_CODE" == "200" ]] || fail "chat stream returned HTTP $HTTP_CODE"
grep -q '^event: token$' "$TMP/chat.sse" || fail "chat stream had no token event"
grep -q '^event: done$' "$TMP/chat.sse" || fail "chat stream had no done event"
grep -q 'smoke: ' "$TMP/chat.sse" || fail "chat stream did not use the offline provider"
if grep -q '^event: error$' "$TMP/chat.sse"; then
	fail "chat stream reported an error"
fi
echo "ok  chat stream"

echo "smoke: all checks passed"
