"""Approvals repository for exact, expiring tool authorization."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from typing import Any

from app.db.repositories.base import BaseRepo, transaction


class ApprovalRepo(BaseRepo):
    """Stores and resolves cryptographic tool-call approvals."""

    table = "approvals"

    def __init__(self, conn: sqlite3.Connection) -> None:
        super().__init__(conn)

    @staticmethod
    def compute_hash(tool_name: str, arguments: dict[str, Any]) -> str:
        """Deterministic sha256 hash of canonicalized tool name and arguments.

        Keys are recursively sorted and formatted without whitespace so identical
        payloads produce the exact same hash regardless of dict key ordering.
        """
        canonical_args = json.dumps(arguments, sort_keys=True, separators=(",", ":"))
        raw = f"{tool_name}:{canonical_args}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def create_request(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        requested_by: str,
        ttl_seconds: int = 300,
    ) -> dict[str, Any]:
        """Create a pending approval request with a unique ID and expiration."""
        req_id = f"appr_{uuid.uuid4().hex[:12]}"
        now = time.time()
        expires_at = now + ttl_seconds
        action_hash = self.compute_hash(tool_name, arguments)
        args_json = json.dumps(arguments, sort_keys=True, separators=(",", ":"))

        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO approvals (
                    id, action_hash, tool_name, arguments_json,
                    status, expires_at, requested_by, created_at
                ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (req_id, action_hash, tool_name, args_json, expires_at, requested_by, now),
            )

        return {
            "id": req_id,
            "action_hash": action_hash,
            "tool_name": tool_name,
            "arguments": arguments,
            "status": "pending",
            "expires_at": expires_at,
            "requested_by": requested_by,
            "resolved_by": None,
            "created_at": now,
            "resolved_at": None,
        }

    def resolve(
        self,
        approval_id: str,
        decision: str,
        resolved_by: str,
    ) -> dict[str, Any] | None:
        """Resolve a pending approval if not expired.

        Returns the updated approval record dict, or None if the approval does
        not exist, has already been resolved, or has expired.
        """
        if decision not in ("approved", "rejected"):
            raise ValueError(f"Invalid decision: {decision}")

        now = time.time()
        with transaction(self.conn):
            cur = self.conn.execute(
                """
                UPDATE approvals
                SET status = ?, resolved_by = ?, resolved_at = ?
                WHERE id = ? AND status = 'pending' AND expires_at > ?
                RETURNING id, action_hash, tool_name, arguments_json, status,
                          expires_at, requested_by, resolved_by, created_at, resolved_at
                """,
                (decision, resolved_by, now, approval_id, now),
            )
            row = cur.fetchone()
            if not row:
                return None
            return {
                "id": row["id"],
                "action_hash": row["action_hash"],
                "tool_name": row["tool_name"],
                "arguments": json.loads(row["arguments_json"]) if isinstance(row["arguments_json"], str) else (row["arguments_json"] or {}),
                "status": row["status"],
                "expires_at": float(row["expires_at"]),
                "requested_by": row["requested_by"],
                "resolved_by": row["resolved_by"],
                "created_at": float(row["created_at"]),
                "resolved_at": float(row["resolved_at"]) if row["resolved_at"] is not None else None,
            }

    def is_approved(self, action_hash: str) -> bool:
        """Return True if an unexpired approved record exists for the exact action_hash."""
        now = time.time()
        row = self._one(
            """
            SELECT id FROM approvals
            WHERE action_hash = ? AND status = 'approved' AND expires_at > ?
            ORDER BY resolved_at DESC LIMIT 1
            """,
            (action_hash, now),
        )
        return row is not None

    def list_pending(self, requested_by: str | None = None) -> list[dict[str, Any]]:
        """Return all unexpired pending approval requests, optionally filtered by requester."""
        now = time.time()
        if requested_by is not None:
            rows = self._all(
                """
                SELECT id, action_hash, tool_name, arguments_json, status,
                       expires_at, requested_by, resolved_by, created_at, resolved_at
                FROM approvals
                WHERE status = 'pending' AND expires_at > ? AND requested_by = ?
                ORDER BY created_at DESC
                """,
                (now, requested_by),
            )
        else:
            rows = self._all(
                """
                SELECT id, action_hash, tool_name, arguments_json, status,
                       expires_at, requested_by, resolved_by, created_at, resolved_at
                FROM approvals
                WHERE status = 'pending' AND expires_at > ?
                ORDER BY created_at DESC
                """,
                (now,),
            )

        return [
            {
                "id": row["id"],
                "action_hash": row["action_hash"],
                "tool_name": row["tool_name"],
                "arguments": json.loads(row["arguments_json"]) if isinstance(row["arguments_json"], str) else (row["arguments_json"] or {}),
                "status": row["status"],
                "expires_at": float(row["expires_at"]),
                "requested_by": row["requested_by"],
                "resolved_by": row["resolved_by"],
                "created_at": float(row["created_at"]),
                "resolved_at": float(row["resolved_at"]) if row["resolved_at"] is not None else None,
            }
            for row in rows
        ]

    def get(self, approval_id: str) -> dict[str, Any] | None:
        """Retrieve an approval record by id."""
        row = self._one(
            """
            SELECT id, action_hash, tool_name, arguments_json, status,
                   expires_at, requested_by, resolved_by, created_at, resolved_at
            FROM approvals
            WHERE id = ?
            """,
            (approval_id,),
        )
        if not row:
            return None
        return {
            "id": row["id"],
            "action_hash": row["action_hash"],
            "tool_name": row["tool_name"],
            "arguments": json.loads(row["arguments_json"]) if isinstance(row["arguments_json"], str) else (row["arguments_json"] or {}),
            "status": row["status"],
            "expires_at": float(row["expires_at"]),
            "requested_by": row["requested_by"],
            "resolved_by": row["resolved_by"],
            "created_at": float(row["created_at"]),
            "resolved_at": float(row["resolved_at"]) if row["resolved_at"] is not None else None,
        }
