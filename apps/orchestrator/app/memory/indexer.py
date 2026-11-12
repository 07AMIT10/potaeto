"""Index the `agent-memory` markdown tree into SQLite + FTS5.

Markdown files stay canonical. Each file is one memory node with YAML-subset
frontmatter; the indexer hashes the raw file, skips nodes whose hash is
unchanged, and upserts the rest into ``memories`` (which keeps ``memories_fts``
in sync through the triggers in ``0001_initial.sql``).

Indexing is deliberately *content-only*: it never rewrites ``status`` or
``user_confirmed`` on an existing row, so retraction and confirmation survive
later walks of the tree.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from typing import Any

from app.db.repositories.memories import MemoryRepo

DEFAULT_USER_ID = "u_local"

# `agent-memory` uses an enum for confidence; SQLite stores a number.
CONFIDENCE_BY_LABEL = {
    "measured": 0.95,
    "corroborated": 0.85,
    "estimated": 0.6,
    "fabricated": 0.2,
}
DEFAULT_CONFIDENCE = 0.5


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """Split a markdown file into (frontmatter, body).

    Supports the YAML subset `agent-memory` writes: scalar ``key: value`` pairs,
    quoted strings, and inline lists such as ``tags: ["a", "b"]``. A file
    without frontmatter yields an empty mapping (e.g. generated ``INDEX.md``).
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text.strip()
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return {}, text.strip()

    meta: dict[str, object] = {}
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition(":")
        if not separator:
            continue
        meta[key.strip()] = _parse_scalar(value.strip())
    return meta, "\n".join(lines[end + 1 :]).strip()


def _parse_scalar(value: str) -> object:
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(item.strip()) for item in inner.split(",")]
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    lowered = value.lower()
    if lowered in ("true", "false"):
        return lowered == "true"
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


class MemoryIndexer:
    """Mirror the markdown memory tree into the ``memories`` table."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.repo = MemoryRepo(conn)

    def reindex(self, root: Path) -> int:
        """Upsert changed nodes under ``root``; return how many were written."""
        root = Path(root)
        if not root.exists():
            return 0

        changed = 0
        for path in sorted(root.rglob("*.md")):
            relative = path.relative_to(root)
            if any(part.startswith(".") for part in relative.parts):
                continue
            raw = path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(raw)
            node_id = str(meta.get("id") or "").strip()
            if not node_id:
                continue  # INDEX.md and other generated files have no node id

            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
            existing = self.repo.get(node_id, include_deleted=True)
            if existing is not None and existing.content_hash == digest:
                continue

            fields = self._node_fields(meta, body, relative)
            if existing is None:
                self.repo.create(
                    user_id=DEFAULT_USER_ID,
                    memory_id=node_id,
                    content_hash=digest,
                    **fields,
                )
            else:
                if existing.status != "active":
                    # Governance wins over a re-walk: refresh content and the
                    # hash, but never resurrect status or user confirmation.
                    fields.pop("user_confirmed", None)
                self.repo.update(node_id, content_hash=digest, **fields)
            changed += 1
        return changed

    @staticmethod
    def _node_fields(
        meta: dict[str, object], body: str, relative: Path
    ) -> dict[str, Any]:
        title = str(meta.get("title") or "").strip()
        content = f"{title}\n\n{body}".strip() if title else body.strip()
        if not content:
            content = title or relative.stem

        project = str(meta.get("project") or "_global").strip()
        scope = "global" if project in ("", "_global") else f"project:{project}"
        source = str(meta.get("source") or "agent-memory").strip()
        label = str(meta.get("confidence") or "").strip().lower()

        return {
            "entity_id": None,
            "kind": str(meta.get("type") or meta.get("kind") or "fact").strip(),
            "content": content,
            "source": source,
            "source_ref": relative.as_posix(),
            "confidence": CONFIDENCE_BY_LABEL.get(label, DEFAULT_CONFIDENCE),
            "sensitivity": str(meta.get("sensitivity") or "normal").strip(),
            "scope": scope,
            "valid_from": str(meta.get("created") or "").strip() or None,
            "user_confirmed": source.lower() == "user",
        }
