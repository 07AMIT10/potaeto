#!/usr/bin/env bash
# Back up the Potaeto SQLite database with the online backup API.
#
# A live WAL database must not be copied with `cp`: the copy can miss pages
# still in the WAL. `sqlite3 .backup` (or Python's Connection.backup(), which
# uses the same API when the CLI is unavailable) takes a consistent snapshot
# while the core keeps writing.
#
# Layout and retention:
#   $DEST/daily/potaeto-<UTC timestamp>.db.gz    newest 7 kept
#   $DEST/weekly/potaeto-<ISO week>.db.gz        newest 4 kept
#
# The canonical agent-memory markdown tree is versioned with git, so a backup
# commits local changes when ~/agent-memory is a repository. It is never pushed
# automatically; point an origin at a private remote if off-box copies matter.
#
# Usage:
#   scripts/backup.sh [--db PATH] [--dest DIR] [--memory-dir DIR] [--no-memory-git]
#
# Environment defaults:
#   POTAETO_DB_PATH       /opt/potaeto/data/potaeto.db
#   POTAETO_BACKUP_DIR    $HOME/potaeto-backups
#   POTAETO_MEMORY_DIR    $HOME/agent-memory
set -euo pipefail
# Backups contain chat history and device-token hashes; keep them private even
# when created by an admin shell or cron with a permissive default umask.
umask 077

DB="${POTAETO_DB_PATH:-/opt/potaeto/data/potaeto.db}"
DEST="${POTAETO_BACKUP_DIR:-$HOME/potaeto-backups}"
MEMORY_DIR="${POTAETO_MEMORY_DIR:-$HOME/agent-memory}"
MEMORY_GIT=1
DAILY_KEEP=7
WEEKLY_KEEP=4

usage() {
	cat <<'EOF'
Back up the Potaeto SQLite database with the online backup API.

Usage:
  scripts/backup.sh [--db PATH] [--dest DIR] [--memory-dir DIR] [--no-memory-git]

Environment defaults:
  POTAETO_DB_PATH       /opt/potaeto/data/potaeto.db
  POTAETO_BACKUP_DIR    $HOME/potaeto-backups
  POTAETO_MEMORY_DIR    $HOME/agent-memory
EOF
}

while (($# > 0)); do
	case "$1" in
	--db)
		DB="${2:?--db needs a path}"
		shift 2
		;;
	--dest)
		DEST="${2:?--dest needs a path}"
		shift 2
		;;
	--memory-dir)
		MEMORY_DIR="${2:?--memory-dir needs a path}"
		shift 2
		;;
	--no-memory-git)
		MEMORY_GIT=0
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "backup: unknown argument: $1" >&2
		exit 2
		;;
	esac
done

if [[ ! -f "$DB" ]]; then
	echo "backup: database not found: $DB" >&2
	exit 1
fi
if [[ "$DEST" == *"'"* ]]; then
	# The .backup command takes a single-quoted SQL string.
	echo "backup: destination path must not contain a single quote: $DEST" >&2
	exit 2
fi

PYTHON_BIN="${POTAETO_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
	if command -v python3 >/dev/null 2>&1; then
		PYTHON_BIN="$(command -v python3)"
	else
		echo "backup: python3 is required for gzip/integrity checks" >&2
		exit 1
	fi
fi
if ! command -v gzip >/dev/null 2>&1; then
	echo "backup: gzip is required" >&2
	exit 1
fi

DAILY="$DEST/daily"
WEEKLY="$DEST/weekly"
mkdir -p "$DAILY" "$WEEKLY"

# Serialize overlapping cron/manual runs. The lock file is not a backup.
if command -v flock >/dev/null 2>&1; then
	exec 9>"$DEST/.backup.lock"
	if ! flock -n 9; then
		echo "backup: another backup is already running" >&2
		exit 1
	fi
fi

STAMP="$(date -u +%Y%m%dT%H%M%S%NZ)"
TARGET="$DAILY/potaeto-$STAMP.db.gz"
STAGE="$(mktemp "$DEST/.backup.XXXXXX.db")"
TMP_GZ="$TARGET.tmp"
VERIFY_DB="$(mktemp "$DEST/.verify.XXXXXX.db")"
SUCCESS=0
cleanup() {
	rm -f "$STAGE" "$TMP_GZ" "$VERIFY_DB"
	# Do not leave a partial/corrupt archive behind after a failed run.
	if [[ "$SUCCESS" != 1 ]]; then
		rm -f "$TARGET"
	fi
}
trap cleanup EXIT

# 1. Consistent snapshot, never a raw copy of a live WAL database.
if command -v sqlite3 >/dev/null 2>&1; then
	sqlite3 "$DB" ".timeout 5000" ".backup '$STAGE'"
else
	# Same online-backup API as `.backup`, for boxes without the CLI.
	"$PYTHON_BIN" - "$DB" "$STAGE" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1], timeout=5.0)
destination = sqlite3.connect(sys.argv[2])
try:
    source.backup(destination)
finally:
    destination.close()
    source.close()
PY
fi

# 2. Compress atomically, then prove the archive is readable.
gzip -c "$STAGE" >"$TMP_GZ"
mv -f "$TMP_GZ" "$TARGET"
gzip -t "$TARGET"

# 3. Verify the snapshot can be restored and is internally consistent.
gzip -dc "$TARGET" >"$VERIFY_DB"
"$PYTHON_BIN" - "$VERIFY_DB" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
try:
    result = connection.execute("PRAGMA integrity_check").fetchone()
finally:
    connection.close()
if result is None or result[0] != "ok":
    raise SystemExit(f"backup: integrity check failed: {result}")
PY
rm -f "$VERIFY_DB"

# 4. Keep one snapshot per ISO week, refreshed by later runs in that week.
WEEK="$(date -u +%G-W%V)"
cp -f "$TARGET" "$WEEKLY/potaeto-$WEEK.db.gz"

# 5. Retention: newest 7 daily, newest 4 weekly.
prune() {
	local dir="$1" keep="$2"
	local -a files=()
	mapfile -d '' -t files < <(
		find "$dir" -maxdepth 1 -type f -name 'potaeto-*.db.gz' -print0 | sort -z -r
	)
	local i
	for ((i = keep; i < ${#files[@]}; i++)); do
		rm -f -- "${files[$i]}"
	done
}
prune "$DAILY" "$DAILY_KEEP"
prune "$WEEKLY" "$WEEKLY_KEEP"
SUCCESS=1

echo "backup: $TARGET ($(du -h "$TARGET" | cut -f1), integrity ok)"

# 6. agent-memory is canonical in git; commit local changes (never push).
if [[ "$MEMORY_GIT" == 1 && -d "$MEMORY_DIR/.git" ]]; then
	if ! git -C "$MEMORY_DIR" add -A; then
		echo "backup: warning: agent-memory git add failed" >&2
	elif git -C "$MEMORY_DIR" diff --cached --quiet; then
		echo "agent-memory: no local changes"
	elif git -C "$MEMORY_DIR" commit -m "backup: $STAMP" >/dev/null; then
		echo "agent-memory: committed local changes"
	else
		echo "backup: warning: agent-memory commit failed" >&2
	fi
fi
