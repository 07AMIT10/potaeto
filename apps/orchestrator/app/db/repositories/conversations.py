"""Conversation repository. One shared thread per (user, primary agent)."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, from_row, new_id, transaction


@dataclass(frozen=True)
class Conversation:
    id: str
    user_id: str
    entity_id: str
    title: str | None
    created_at: str
    updated_at: str
    rev: int
    deleted: int


class ConversationRepo(BaseRepo):
    table = "conversations"
    _UPDATABLE = ("title", "deleted")

    def _to_model(self, row) -> Conversation:
        return from_row(Conversation, row)

    def ensure_conversation(
        self, user_id: str, entity_id: str, *, title: str | None = None
    ) -> Conversation:
        """Return the existing (user, entity) thread, creating it on first use."""
        row = self._one(
            "SELECT * FROM conversations WHERE user_id = ? AND entity_id = ?",
            (user_id, entity_id),
        )
        if row is not None:
            return self._revive_or_return(row)
        try:
            return self.create(user_id, entity_id, title=title)
        except sqlite3.IntegrityError:
            # Two devices booting together both saw no row and both inserted;
            # the UNIQUE (user_id, entity_id) constraint picked a winner, so
            # re-select that row instead of failing the second request.
            row = self._one(
                "SELECT * FROM conversations WHERE user_id = ? AND entity_id = ?",
                (user_id, entity_id),
            )
            return self._revive_or_return(
                self.require(row, "conversation", (user_id, entity_id))
            )

    def _revive_or_return(self, row: sqlite3.Row) -> Conversation:
        conversation = self._to_model(row)
        if conversation.deleted:
            # A tombstoned thread is revived rather than duplicated: the
            # (user_id, entity_id) pair is unique.
            return self.update(conversation.id, deleted=0)
        return conversation

    def create(
        self,
        user_id: str,
        entity_id: str,
        *,
        title: str | None = None,
        conversation_id: str | None = None,
    ) -> Conversation:
        identifier = conversation_id or new_id("c")
        with transaction(self.conn):
            self.conn.execute(
                "INSERT INTO conversations (id, user_id, entity_id, title) VALUES (?, ?, ?, ?)",
                (identifier, user_id, entity_id, title),
            )
        return self.require(self.get(identifier), "conversation", identifier)

    def get(self, conversation_id: str, *, include_deleted: bool = False) -> Conversation | None:
        row = self._one("SELECT * FROM conversations WHERE id = ?", (conversation_id,))
        if row is None or (row["deleted"] and not include_deleted):
            return None
        return self._to_model(row)

    def list(
        self,
        user_id: str | None = None,
        *,
        entity_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[Conversation]:
        where, params = self._filter_clause(
            {"user_id": user_id, "entity_id": entity_id}, include_deleted=include_deleted
        )
        rows = self._all(
            f"SELECT * FROM conversations{where} ORDER BY updated_at DESC", params
        )
        return [self._to_model(row) for row in rows]

    def update(self, conversation_id: str, **fields: Any) -> Conversation:
        self._update(conversation_id, fields, self._UPDATABLE)
        return self.require(
            self.get(conversation_id, include_deleted=True), "conversation", conversation_id
        )
