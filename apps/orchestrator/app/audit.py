"""Append-only audit trail for security-relevant actions.

Every privileged or security-relevant event — tool calls, approvals, auth
failures, SSRF blocks, admin access — lands in the ``audit_events`` table.
``record`` raises on a database failure so tests and callers can detect a broken
trail; request handlers that must not fail use :func:`audit_safely`.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from app.db.repositories.audit import AuditEvent, AuditRepo

logger = logging.getLogger(__name__)


def _detail(detail: Mapping[str, Any] | str | None) -> dict[str, Any]:
    if detail is None:
        return {}
    if isinstance(detail, str):
        return {"message": detail}
    return dict(detail)


@dataclass(frozen=True)
class AuditLog:
    """Write security events to the SQLite audit table."""

    db: sqlite3.Connection

    def record(
        self,
        actor: str | None,
        kind: str,
        subject: str | None = None,
        detail: Mapping[str, Any] | str | None = None,
    ) -> AuditEvent:
        """Append one event and return the stored row."""
        return AuditRepo(self.db).create(
            kind,
            actor=actor,
            subject=subject,
            detail=_detail(detail),
        )


def audit_safely(
    db: sqlite3.Connection | None,
    actor: str | None,
    kind: str,
    subject: str | None = None,
    detail: Mapping[str, Any] | str | None = None,
) -> None:
    """Best-effort audit write for request paths that must keep working."""
    if db is None:
        return
    try:
        AuditLog(db).record(actor, kind, subject, detail)
    except Exception:
        logger.exception("audit: failed to record %s for %s", kind, subject)
