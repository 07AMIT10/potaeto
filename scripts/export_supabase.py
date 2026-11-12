#!/usr/bin/env python3
"""Read-only Supabase export for the SQLite migration.

Release 1 retires Supabase, so this script copies the five durable tables into
plain JSON before the project is turned down:

    entities, conversations, messages, memories, conversation_summaries

It only issues GET requests with the service-role key (needed to bypass RLS);
nothing is ever written back to Supabase. The key is read from the environment
and is never printed, stored in the manifest, or included in error output.

Credentials (environment):
    SUPABASE_URL                 or NEXT_PUBLIC_SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY    required for RLS-protected tables

Examples:
    # Counts only; no output directory is created.
    python3 scripts/export_supabase.py --dry-run

    # Offline rehearsal against a local JSON fixture.
    python3 scripts/export_supabase.py --dry-run --fixture scripts/fixtures/supabase_export_fixture.json

    # Real export to exports/supabase-<timestamp>/
    python3 scripts/export_supabase.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TABLES = (
    "entities",
    "conversations",
    "messages",
    "memories",
    "conversation_summaries",
)

# Stable pagination order per table (conversation_summaries has no `id`).
ORDER_COLUMNS = {
    "entities": "id",
    "conversations": "id",
    "messages": "id",
    "memories": "id",
    "conversation_summaries": "conversation_id",
}

PAGE_SIZE = 1000
REQUEST_TIMEOUT_SEC = 60


class ExportError(Exception):
    """A configuration or response problem that should abort the export."""


def env(name: str) -> str:
    return os.environ.get(name, "").strip()


def resolve_credentials() -> tuple[str, str]:
    url = env("SUPABASE_URL") or env("NEXT_PUBLIC_SUPABASE_URL")
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise ExportError(
            "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and "
            "SUPABASE_SERVICE_ROLE_KEY must be set; use --fixture for an offline run"
        )
    if not url.startswith(("https://", "http://")):
        raise ExportError("SUPABASE_URL must start with http:// or https://")
    return url.rstrip("/"), key


def _request(url: str, key: str, *, count_only: bool = False) -> urllib.request.Request:
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if count_only:
        headers["Prefer"] = "count=exact"
    return urllib.request.Request(url, headers=headers, method="GET")


def _get_json(
    url: str, key: str, *, count_only: bool = False
) -> tuple[Any, dict[str, str]]:
    """GET a PostgREST URL and decode JSON, without leaking request secrets."""
    request = _request(url, key, count_only=count_only)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SEC) as response:
            body = response.read()
            headers = {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as exc:
        detail = exc.read(500).decode("utf-8", "replace").replace(key, "[redacted]")
        raise ExportError(f"Supabase returned HTTP {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise ExportError(f"could not reach Supabase: {exc.reason}") from None
    try:
        return json.loads(body or b"null"), headers
    except json.JSONDecodeError as exc:
        raise ExportError(f"Supabase returned invalid JSON: {exc}") from None


def _table_url(base: str, table: str, *, limit: int, offset: int = 0) -> str:
    query = urllib.parse.urlencode(
        {
            "select": "*",
            "order": f"{ORDER_COLUMNS[table]}.asc",
            "limit": limit,
            "offset": offset,
        }
    )
    return f"{base}/rest/v1/{table}?{query}"


def count_live(base: str, key: str, table: str) -> int:
    """Return the table's row count using one request (Content-Range)."""
    url = _table_url(base, table, limit=1)
    rows, headers = _get_json(url, key, count_only=True)
    if not isinstance(rows, list):
        raise ExportError(f"{table}: expected a JSON array")
    content_range = headers.get("content-range", "")
    if "/" in content_range:
        total = content_range.rsplit("/", 1)[-1]
        if total.isdigit():
            return int(total)
    if not rows:
        return 0
    # Fallback for proxies that strip Content-Range: paginate and count.
    return sum(1 for _ in iter_live_rows(base, key, table))


def iter_live_rows(base: str, key: str, table: str) -> Iterator[dict[str, Any]]:
    """Yield every row for `table`, page by page, in a stable order."""
    offset = 0
    while True:
        rows, _ = _get_json(_table_url(base, table, limit=PAGE_SIZE, offset=offset), key)
        if not isinstance(rows, list):
            raise ExportError(f"{table}: expected a JSON array")
        for row in rows:
            if not isinstance(row, dict):
                raise ExportError(f"{table}: expected JSON objects")
            yield row
        if len(rows) < PAGE_SIZE:
            return
        offset += len(rows)


def iter_fixture_rows(
    fixture: dict[str, Any], table: str
) -> Iterator[dict[str, Any]]:
    rows = fixture.get(table, [])
    if not isinstance(rows, list):
        raise ExportError(f"fixture: {table} must be a list")
    for row in rows:
        if not isinstance(row, dict):
            raise ExportError(f"fixture: {table} entries must be objects")
        yield row


def load_fixture(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ExportError(f"cannot read fixture {path}: {exc}") from None
    except json.JSONDecodeError as exc:
        raise ExportError(f"fixture {path} is not valid JSON: {exc}") from None
    if not isinstance(data, dict):
        raise ExportError("fixture must be a JSON object keyed by table name")
    return data


def default_output_dir() -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path("exports") / f"supabase-{stamp}"


def count_rows(*, fixture: dict[str, Any] | None) -> dict[str, int]:
    """Return row counts from the fixture or live Supabase (dry run)."""
    if fixture is not None:
        return {
            table: sum(1 for _ in iter_fixture_rows(fixture, table))
            for table in TABLES
        }

    base, key = resolve_credentials()
    return {table: count_live(base, key, table) for table in TABLES}


def collect_rows(
    fixture: dict[str, Any] | None,
) -> dict[str, list[dict[str, Any]]]:
    """Read all rows into memory (Release 1 data is one local user's archive)."""
    if fixture is not None:
        return {table: list(iter_fixture_rows(fixture, table)) for table in TABLES}

    base, key = resolve_credentials()
    return {table: list(iter_live_rows(base, key, table)) for table in TABLES}


def write_export(output: Path, rows: dict[str, list[dict[str, Any]]]) -> None:
    try:
        output.mkdir(parents=True, exist_ok=False)
    except OSError as exc:
        raise ExportError(f"cannot create output directory {output}: {exc}") from None
    generated_at = datetime.now(timezone.utc).isoformat()
    manifest: dict[str, Any] = {
        "generated_at": generated_at,
        "source": "supabase",
        "tables": {},
    }
    for table in TABLES:
        table_rows = rows[table]
        (output / f"{table}.json").write_text(
            json.dumps(table_rows, indent=2, sort_keys=True, default=str) + "\n",
            encoding="utf-8",
        )
        manifest["tables"][table] = {
            "count": len(table_rows),
            "file": f"{table}.json",
        }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only export of the Potaeto Supabase tables to JSON.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print row counts and write nothing",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="output directory (default: exports/supabase-<UTC timestamp>)",
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=None,
        help="read table rows from a local JSON fixture instead of Supabase",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        fixture = load_fixture(args.fixture) if args.fixture else None
        if args.dry_run:
            counts = count_rows(fixture=fixture)
            for table in TABLES:
                print(f"{table}: {counts[table]}")
            print("dry run: no files written")
            return 0

        if fixture is not None:
            raise ExportError("--fixture is only supported with --dry-run")
        rows = collect_rows(None)
        output = args.output or default_output_dir()
        write_export(output, rows)
        for table in TABLES:
            print(f"{table}: {len(rows[table])}")
        print(f"export: wrote {output}")
        return 0
    except ExportError as exc:
        print(f"export: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
