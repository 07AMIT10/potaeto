"""Message repository: append-only turns with a per-conversation sequence."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, fts_query, new_id
from app.db.repositories.conversations import Conversation, ConversationRepo


@dataclass(frozen=True)
class Message:
    id: str
    seq: int
    conversation_id: str
    user_id: str
    role: str
    content: str
    channel: str
    meta_json: dict[str, Any]
    created_at: str
    updated_at: str
    rev: int
    deleted: int


class MessageRepo(BaseRepo):
    table = "messages"
    _UPDATABLE = ("content", "meta_json", "deleted")

    def __init__(self, conn) -> None:
        super().__init__(conn)
        self.conversations = ConversationRepo(conn)

    def _to_model(self, row) -> Message:
        return from_row(Message, row, ("meta_json",))

    def ensure_conversation(self, user_id: str, entity_id: str) -> Conversation:
        """Convenience delegate used by callers that only hold a MessageRepo."""
        return self.conversations.ensure_conversation(user_id, entity_id)

    def append(
        self,
        conversation_id: str,
        user_id: str,
        role: str,
        content: str,
        channel: str = "app",
        meta: dict[str, Any] | None = None,
        *,
        message_id: str | None = None,
    ) -> Message:
        """Insert a message, assigning the next `seq` and `rev = 1` atomically.

        ``message_id`` lets sync pushes keep the client-generated ULID, which
        makes a retried insert collide with itself instead of duplicating.
        """
        identifier = message_id or new_id("m")
        with self.write_transaction():
            seq = self._scalar(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            )
            self.conn.execute(
                """
                INSERT INTO messages (
                    id, seq, conversation_id, user_id, role, content, channel,
                    meta_json, rev
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    identifier,
                    seq,
                    conversation_id,
                    user_id,
                    role,
                    content,
                    channel,
                    dump_json(meta or {}),
                ),
            )
            self.conn.execute(
                "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?",
                (conversation_id,),
            )
        return self.require(self.get(identifier), "message", identifier)

    def create(
        self,
        conversation_id: str,
        user_id: str,
        role: str,
        content: str,
        channel: str = "app",
        meta: dict[str, Any] | None = None,
    ) -> Message:
        """Alias for :meth:`append` matching the common repo interface."""
        return self.append(conversation_id, user_id, role, content, channel, meta)

    def get(self, message_id: str, *, include_deleted: bool = False) -> Message | None:
        row = self._one("SELECT * FROM messages WHERE id = ?", (message_id,))
        if row is None or (row["deleted"] and not include_deleted):
            return None
        return self._to_model(row)

    def last(self, conversation_id: str) -> Message | None:
        """Return the newest live message in a conversation, if any."""
        row = self._one(
            """
            SELECT * FROM messages
            WHERE conversation_id = ? AND deleted = 0
            ORDER BY seq DESC LIMIT 1
            """,
            (conversation_id,),
        )
        return None if row is None else self._to_model(row)

    def list(
        self,
        conversation_id: str,
        *,
        after_seq: int = 0,
        limit: int | None = None,
        include_deleted: bool = False,
    ) -> list[Message]:
        clauses = ["conversation_id = ?", "seq > ?"]
        params: list[Any] = [conversation_id, after_seq]
        if not include_deleted:
            clauses.append("deleted = 0")
        sql = f"SELECT * FROM messages WHERE {' AND '.join(clauses)} ORDER BY seq"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return [self._to_model(row) for row in self._all(sql, params)]

    def update(self, message_id: str, **fields: Any) -> Message:
        self._update(message_id, fields, self._UPDATABLE)
        return self.require(
            self.get(message_id, include_deleted=True), "message", message_id
        )

    def search(self, conversation_id: str, query: str, *, limit: int = 20) -> list[Message]:
        """Full-text search within one conversation (FTS5/BM25)."""
        match = fts_query(query)
        if not match:
            return []
        rows = self._all(
            """
            SELECT m.* FROM messages_fts f
            JOIN messages m ON m.rowid = f.rowid
            WHERE messages_fts MATCH ? AND m.conversation_id = ? AND m.deleted = 0
            ORDER BY bm25(messages_fts) LIMIT ?
            """,
            (match, conversation_id, limit),
        )
        return [self._to_model(row) for row in rows]
