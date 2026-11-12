"""Developer CLI for local core operations.

Release 1 pairs devices with a short-lived code, but has no public endpoint for
creating one (that would let any caller mint credentials). Operators run this
CLI on the server instead::

    cd apps/orchestrator
    python -m app.cli pair --user u_local

The code is printed once to stdout; it is single-use and expires after
``--ttl`` seconds. The database defaults to ``POTAETO_DB_PATH`` and is migrated
on demand, so the CLI works before or after the systemd service starts.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from app.auth.pairing import DEFAULT_CODE_TTL_SEC, PairingService
from app.config import DEFAULT_DB_PATH
from app.db.connection import connect_db, run_migrations
from app.memory.indexer import MemoryIndexer

DEFAULT_USER_ID = "u_local"
DEFAULT_MEMORY_ROOT = "~/agent-memory"


def create_pairing_code(
    *,
    db_path: str | os.PathLike[str] | None = None,
    user_id: str = DEFAULT_USER_ID,
    ttl_sec: int = DEFAULT_CODE_TTL_SEC,
) -> str:
    """Create a single-use pairing code for ``user_id`` and return it."""
    path = str(db_path or os.environ.get("POTAETO_DB_PATH", "").strip() or DEFAULT_DB_PATH)
    conn = connect_db(path)
    try:
        run_migrations(conn)
        return PairingService(conn).create_code(user_id, ttl_sec)
    finally:
        conn.close()


def index_memory(
    *,
    db_path: str | os.PathLike[str] | None = None,
    root: str | os.PathLike[str] = DEFAULT_MEMORY_ROOT,
) -> int:
    """Index the markdown memory tree and return how many nodes changed."""
    path = str(db_path or os.environ.get("POTAETO_DB_PATH", "").strip() or DEFAULT_DB_PATH)
    memory_root = Path(root).expanduser()
    conn = connect_db(path)
    try:
        run_migrations(conn)
        return MemoryIndexer(conn).reindex(memory_root)
    finally:
        conn.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli",
        description="Local Potaeto core administration.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    pair = subparsers.add_parser("pair", help="create a device pairing code")
    pair.add_argument(
        "--user",
        default=DEFAULT_USER_ID,
        help=f"user id to pair (default: {DEFAULT_USER_ID})",
    )
    pair.add_argument(
        "--ttl",
        type=int,
        default=DEFAULT_CODE_TTL_SEC,
        help=f"code lifetime in seconds (default: {DEFAULT_CODE_TTL_SEC})",
    )
    pair.add_argument(
        "--db",
        default=None,
        help="SQLite path (default: $POTAETO_DB_PATH or data/potaeto.db)",
    )
    pair.add_argument(
        "--json",
        action="store_true",
        help="print a JSON object instead of only the code",
    )

    index = subparsers.add_parser(
        "index-memory", help="index the agent-memory markdown tree into SQLite"
    )
    index.add_argument(
        "--root",
        default=DEFAULT_MEMORY_ROOT,
        help=f"markdown memory tree (default: {DEFAULT_MEMORY_ROOT})",
    )
    index.add_argument(
        "--db",
        default=None,
        help="SQLite path (default: $POTAETO_DB_PATH or data/potaeto.db)",
    )
    index.add_argument(
        "--json",
        action="store_true",
        help="print a JSON object instead of a human-readable line",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "index-memory":
        try:
            changed = index_memory(db_path=args.db, root=args.root)
        except Exception as exc:  # noqa: BLE001 - CLI reports a clean error
            print(f"error: {exc}", file=sys.stderr)
            return 1
        if args.json:
            print(json.dumps({"root": str(Path(args.root).expanduser()), "changed": changed}))
        else:
            print(f"{changed} memory node(s) updated")
        return 0
    if args.command != "pair":  # pragma: no cover - argparse rejects unknown commands
        return 2
    if args.ttl <= 0:
        print("error: --ttl must be positive", file=sys.stderr)
        return 2
    try:
        code = create_pairing_code(db_path=args.db, user_id=args.user, ttl_sec=args.ttl)
    except Exception as exc:  # noqa: BLE001 - CLI reports a clean error
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"code": code, "user_id": args.user, "ttl_sec": args.ttl}))
    else:
        print(code)
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised via subprocess/smoke
    raise SystemExit(main())
