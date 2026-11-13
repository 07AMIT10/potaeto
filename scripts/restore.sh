#!/usr/bin/env bash
# Restore the Potaeto SQLite database from a compressed backup archive.
#
# Validates the backup archive, checks database integrity and foreign key
# constraints, verifies presence of core tables, and atomically replaces
# destination database (saving any previous version to .bak).
#
# Usage:
#   scripts/restore.sh --backup <path.db.gz> [--dest <path.db>] [--dry-run]
#
# Environment defaults:
#   POTAETO_DB_PATH       /opt/potaeto/data/potaeto.db
set -euo pipefail
umask 077

BACKUP=""
DEST="${POTAETO_DB_PATH:-/opt/potaeto/data/potaeto.db}"
DRY_RUN=0

usage() {
	cat <<'EOF'
Restore the Potaeto SQLite database from a compressed backup archive.

Usage:
  scripts/restore.sh --backup <path.db.gz> [--dest <path.db>] [--dry-run]

Options:
  --backup PATH   Path to the compressed database backup (.db.gz) (required)
  --dest PATH     Destination path for restored database (default: $POTAETO_DB_PATH or /opt/potaeto/data/potaeto.db)
  --dry-run       Validate and check integrity without replacing destination database
  -h, --help      Show this help message and exit
EOF
}

while (($# > 0)); do
	case "$1" in
	--backup)
		BACKUP="${2:?--backup requires a path}"
		shift 2
		;;
	--dest)
		DEST="${2:?--dest requires a path}"
		shift 2
		;;
	--dry-run)
		DRY_RUN=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "restore: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

if [[ -z "$BACKUP" ]]; then
	echo "restore: error: --backup <path.db.gz> is required" >&2
	usage >&2
	exit 2
fi

if [[ ! -f "$BACKUP" ]]; then
	echo "restore: error: backup file does not exist: $BACKUP" >&2
	exit 1
fi

if ! gzip -t "$BACKUP" >/dev/null 2>&1; then
	echo "restore: error: backup file is not a valid gzip file: $BACKUP" >&2
	exit 1
fi

PYTHON_BIN="${POTAETO_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
	if command -v python3 >/dev/null 2>&1; then
		PYTHON_BIN="$(command -v python3)"
	fi
fi

run_sql() {
	local db_file="$1"
	local sql="$2"
	if command -v sqlite3 >/dev/null 2>&1; then
		sqlite3 "$db_file" "$sql"
	elif [[ -n "$PYTHON_BIN" ]]; then
		"$PYTHON_BIN" - "$db_file" "$sql" <<'PY'
import sqlite3
import sys

conn = sqlite3.connect(sys.argv[1])
try:
    cursor = conn.execute(sys.argv[2])
    rows = cursor.fetchall()
    for row in rows:
        print("|".join(str(v) for v in row))
finally:
    conn.close()
PY
	else
		echo "restore: error: neither sqlite3 CLI nor python3 is available" >&2
		exit 1
	fi
}

TMPDIR="${TMPDIR:-/tmp}"
TMP_RESTORE="$(mktemp "$TMPDIR/potaeto-restore.XXXXXX.db")"
SUCCESS=0
cleanup() {
	rm -f "$TMP_RESTORE"
}
trap cleanup EXIT

if ! gzip -dc "$BACKUP" >"$TMP_RESTORE"; then
	echo "restore: error: decompression failed for $BACKUP" >&2
	exit 1
fi

INTEGRITY_CHECK="$(run_sql "$TMP_RESTORE" "PRAGMA integrity_check;")"
if [[ "$INTEGRITY_CHECK" != "ok" ]]; then
	echo "restore: error: database integrity check failed: $INTEGRITY_CHECK" >&2
	exit 1
fi

FK_CHECK="$(run_sql "$TMP_RESTORE" "PRAGMA foreign_key_check;")"
if [[ -n "$FK_CHECK" && "$FK_CHECK" != "ok" ]]; then
	echo "restore: error: database foreign key check failed: $FK_CHECK" >&2
	exit 1
fi

CORE_TABLES=(users conversations messages memories approvals serial_events)
TABLES_LIST="$(run_sql "$TMP_RESTORE" "SELECT name FROM sqlite_master WHERE type='table';")"
for tbl in "${CORE_TABLES[@]}"; do
	if ! echo "$TABLES_LIST" | grep -qx "$tbl"; then
		echo "restore: error: missing core table '$tbl' in backup schema" >&2
		exit 1
	fi
done

if [[ "$DRY_RUN" == 1 ]]; then
	echo "restore: dry run successful (archive valid, integrity ok, foreign keys ok, core tables present)"
	SUCCESS=1
	exit 0
fi

DEST_DIR="$(dirname "$DEST")"
mkdir -p "$DEST_DIR"

if [[ -f "$DEST" ]]; then
	mv -f "$DEST" "$DEST.bak"
	rm -f "$DEST-wal" "$DEST-shm"
	echo "restore: existing database moved to $DEST.bak"
fi

mv -f "$TMP_RESTORE" "$DEST"
SUCCESS=1
echo "restore: database restored successfully to $DEST"
