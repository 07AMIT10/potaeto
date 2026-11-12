"""Sync repository: change log, device cursors, and idempotent client operations.

Server-authoritative: every applied write appends a ``sync_changes`` row and
receives the next global ``seq``. Clients pull after a cursor, push writes with
an idempotency key and a ``base_rev``, and ack what they have applied. There is
no merge/CRDT layer.
"""

from __future__ import annotations

import sqlite3
from dataclasses import asdict, dataclass, field
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row
from app.db.repositories.conversations import ConversationRepo
from app.db.repositories.entities import EntityRepo
from app.db.repositories.messages import MessageRepo

# Release 1 has exactly one local user and one primary agent thread.
DEFAULT_USER_ID = "u_local"
PRIMARY_ENTITY_ID = "e_potaeto"

_SUPPORTED_ENTITY_TYPES = ("message", "entity")


@dataclass(frozen=True)
class SyncChange:
    seq: int
    entity_type: str
    entity_id: str
    operation: str
    payload_json: dict[str, Any]
    server_created_at: str


@dataclass(frozen=True)
class DeviceSyncState:
    device_id: str
    last_ack_seq: int
    last_seen: str | None


@dataclass(frozen=True)
class ClientOperation:
    idempotency_key: str
    device_id: str
    operation: str
    status: str
    result_json: dict[str, Any]
    created_at: str


@dataclass(frozen=True)
class PushOperation:
    """One client write, replayable by ``idempotency_key``."""

    idempotency_key: str
    entity_type: str
    entity_id: str
    base_rev: int = 0
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PushResult:
    """Outcome of one pushed operation; ``seq`` is the change-log cursor."""

    idempotency_key: str
    status: str
    rev: int | None = None
    seq: int | None = None
    error: str | None = None


class SyncRepo(BaseRepo):
    """Append-only change log plus per-device cursors and idempotency records."""

    table = "sync_changes"

    def create(
        self,
        entity_type: str,
        entity_id: str,
        operation: str,
        payload: dict[str, Any] | None = None,
    ) -> SyncChange:
        with self.write_transaction():
            cursor = self.conn.execute(
                """
                INSERT INTO sync_changes (entity_type, entity_id, operation, payload_json)
                VALUES (?, ?, ?, ?)
                """,
                (entity_type, entity_id, operation, dump_json(payload or {})),
            )
            seq = cursor.lastrowid
            change = self.require(self.get(seq), "sync change", seq)
        return change

    def record_change(
        self,
        entity_type: str,
        entity_id: str,
        operation: str,
        payload: dict[str, Any] | None = None,
    ) -> int:
        """Append a change to the log and return its global ``seq``."""
        return self.create(entity_type, entity_id, operation, payload).seq

    def get_changes(self, after_seq: int, limit: int = 500) -> list[SyncChange]:
        """Return changes strictly after ``after_seq`` in ascending order."""
        return self.list(after_seq, limit=limit)

    def get(self, seq: int) -> SyncChange | None:
        row = self._one("SELECT * FROM sync_changes WHERE seq = ?", (seq,))
        return None if row is None else from_row(SyncChange, row, ("payload_json",))

    def list(self, after_seq: int = 0, *, limit: int = 500) -> list[SyncChange]:
        rows = self._all(
            "SELECT * FROM sync_changes WHERE seq > ? ORDER BY seq LIMIT ?",
            (after_seq, limit),
        )
        return [from_row(SyncChange, row, ("payload_json",)) for row in rows]

    def last_seq(self) -> int:
        return int(self._scalar("SELECT COALESCE(MAX(seq), 0) FROM sync_changes") or 0)

    def get_device_state(self, device_id: str) -> DeviceSyncState | None:
        row = self._one(
            "SELECT * FROM device_sync_state WHERE device_id = ?", (device_id,)
        )
        return None if row is None else from_row(DeviceSyncState, row)

    def ack(self, device_id: str, seq: int) -> DeviceSyncState:
        """Record a device cursor; acknowledgements never move backwards."""
        with self.write_transaction():
            self.conn.execute(
                """
                INSERT INTO device_sync_state (device_id, last_ack_seq, last_seen)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT (device_id) DO UPDATE SET
                    last_ack_seq = MAX(device_sync_state.last_ack_seq, excluded.last_ack_seq),
                    last_seen = excluded.last_seen
                """,
                (device_id, seq),
            )
            state = self.require(
                self.get_device_state(device_id), "device sync state", device_id
            )
        return state

    def last_ack(self, device_id: str) -> int:
        """Return the device's acknowledged cursor (0 for an unseen device)."""
        state = self.get_device_state(device_id)
        return 0 if state is None else state.last_ack_seq

    def get_operation(self, idempotency_key: str) -> ClientOperation | None:
        row = self._one(
            "SELECT * FROM client_operations WHERE idempotency_key = ?",
            (idempotency_key,),
        )
        return None if row is None else from_row(ClientOperation, row, ("result_json",))

    def record_operation(
        self,
        idempotency_key: str,
        device_id: str,
        operation: str,
        status: str,
        result: dict[str, Any] | None = None,
    ) -> ClientOperation:
        """Store the first result for a key; later duplicates see the original."""
        with self.write_transaction():
            self.conn.execute(
                """
                INSERT INTO client_operations (
                    idempotency_key, device_id, operation, status, result_json
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (idempotency_key) DO NOTHING
                """,
                (
                    idempotency_key,
                    device_id,
                    operation,
                    status,
                    dump_json(result or {}),
                ),
            )
            stored = self.require(
                self.get_operation(idempotency_key), "client operation", idempotency_key
            )
        return stored

    # -- push ---------------------------------------------------------------

    def push(self, device_id: str, operations: list[PushOperation]) -> list[PushResult]:
        """Apply client writes in order; each key is applied at most once."""
        return [self._push_one(device_id, op) for op in operations]

    def _push_one(self, device_id: str, op: PushOperation) -> PushResult:
        # Apply the write and store its result in one transaction, so a crash
        # can never leave an applied write without its idempotency record.
        with self.write_transaction():
            stored = self.get_operation(op.idempotency_key)
            if stored is not None:
                return self._replay(op, stored)
            result = self._apply(device_id, op)
            self.record_operation(
                op.idempotency_key,
                device_id,
                op.entity_type,
                result.status,
                {"rev": result.rev, "seq": result.seq, "error": result.error},
            )
            return result

    def _apply(self, device_id: str, op: PushOperation) -> PushResult:
        if op.entity_type not in _SUPPORTED_ENTITY_TYPES:
            return PushResult(
                op.idempotency_key, "unsupported", error="unsupported_entity_type"
            )
        if op.entity_type == "message":
            return self._push_message(device_id, op)
        return self._push_entity(op)

    @staticmethod
    def _replay(op: PushOperation, stored: ClientOperation) -> PushResult:
        """Return the stored result; an applied write reads back as a duplicate."""
        result = stored.result_json or {}
        status = "duplicate" if stored.status == "applied" else stored.status
        return PushResult(
            op.idempotency_key,
            status,
            result.get("rev"),
            result.get("seq"),
            result.get("error"),
        )

    def _push_message(self, device_id: str, op: PushOperation) -> PushResult:
        """Insert an append-only message, assigning its conversation seq."""
        messages = MessageRepo(self.conn)
        existing = messages.get(op.entity_id, include_deleted=True)
        if existing is not None:
            # Messages are append-only and identified by their client-supplied
            # id, so a pushed id we already hold is the same logical message —
            # e.g. the stream persisted it server-side before the client saw
            # the ack and the client re-pushed it from its outbox with
            # ``base_rev=0``. Report `duplicate` (not `stale_rev`) so the
            # client clears the outbox entry instead of retrying forever.
            # Mutable rows (`_push_entity`) still enforce base_rev conflicts.
            return PushResult(
                op.idempotency_key,
                "duplicate",
                existing.rev,
                self._last_change_seq("message", existing.id),
            )
        if op.base_rev not in (0, None):
            return PushResult(op.idempotency_key, "conflict", 0, error="stale_rev")

        payload = op.payload or {}
        # Server-authoritative: the message belongs to the authenticated
        # device's user; a client-supplied user_id is ignored.
        user_id = self._device_user_id(device_id)
        conversation_id = payload.get("conversation_id")
        if not conversation_id:
            agent_id = payload.get("agent_id") or PRIMARY_ENTITY_ID
            conversation_id = (
                ConversationRepo(self.conn).ensure_conversation(user_id, agent_id).id
            )

        try:
            message = messages.append(
                conversation_id,
                user_id,
                payload.get("role", "user"),
                payload.get("content", ""),
                payload.get("channel", "app"),
                payload.get("meta") or {},
                message_id=op.entity_id,
            )
        except sqlite3.IntegrityError:
            # Unknown conversation (or a concurrent id collision): nothing applied.
            return PushResult(op.idempotency_key, "error", 0, error="integrity_error")
        change = self.create("message", message.id, "insert", asdict(message))
        return PushResult(op.idempotency_key, "applied", message.rev, change.seq)

    def _push_entity(self, op: PushOperation) -> PushResult:
        """Update a mutable row after checking its ``base_rev``."""
        entities = EntityRepo(self.conn)
        existing = entities.get(op.entity_id, include_deleted=True)
        if existing is None:
            return PushResult(op.idempotency_key, "error", 0, error="not_found")
        if op.base_rev != existing.rev:
            return PushResult(
                op.idempotency_key, "conflict", existing.rev, error="stale_rev"
            )
        try:
            entity = entities.update(op.entity_id, **(op.payload or {}))
        except ValueError:
            return PushResult(
                op.idempotency_key, "error", existing.rev, error="invalid_payload"
            )
        except sqlite3.IntegrityError:
            # Statement-level rollback; the surrounding push transaction stays
            # usable and the result is recorded as an error.
            return PushResult(
                op.idempotency_key, "error", existing.rev, error="integrity_error"
            )
        operation = "delete" if entity.deleted else "update"
        change = self.create("entity", entity.id, operation, asdict(entity))
        return PushResult(op.idempotency_key, "applied", entity.rev, change.seq)

    def _device_user_id(self, device_id: str) -> str:
        row = self._one("SELECT user_id FROM devices WHERE id = ?", (device_id,))
        return DEFAULT_USER_ID if row is None else str(row["user_id"])

    def _last_change_seq(self, entity_type: str, entity_id: str) -> int | None:
        value = self._scalar(
            """
            SELECT MAX(seq) FROM sync_changes
            WHERE entity_type = ? AND entity_id = ?
            """,
            (entity_type, entity_id),
        )
        return None if value is None else int(value)
