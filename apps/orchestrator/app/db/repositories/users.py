"""User repository."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, from_row, new_id, transaction


@dataclass(frozen=True)
class User:
    id: str
    name: str
    passphrase_hash: str | None
    created_at: str


class UserRepo(BaseRepo):
    table = "users"
    _UPDATABLE = ("name", "passphrase_hash")

    def _to_model(self, row) -> User:
        return from_row(User, row)

    def create(
        self,
        name: str,
        *,
        user_id: str | None = None,
        passphrase_hash: str | None = None,
    ) -> User:
        identifier = user_id or new_id("u")
        with transaction(self.conn):
            self.conn.execute(
                "INSERT INTO users (id, name, passphrase_hash) VALUES (?, ?, ?)",
                (identifier, name, passphrase_hash),
            )
        return self.require(self.get(identifier), "user", identifier)

    def get(self, user_id: str) -> User | None:
        row = self._one("SELECT * FROM users WHERE id = ?", (user_id,))
        return None if row is None else self._to_model(row)

    def list(self) -> list[User]:
        return [self._to_model(row) for row in self._all("SELECT * FROM users ORDER BY created_at")]

    def update(self, user_id: str, **fields: Any) -> User:
        self._update(user_id, fields, self._UPDATABLE, bump_rev=False, touch=False)
        return self.require(self.get(user_id), "user", user_id)
