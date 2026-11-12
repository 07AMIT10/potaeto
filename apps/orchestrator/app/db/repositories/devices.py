"""Paired device repository (token hashes live here; raw tokens never do)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, from_row, new_id, transaction


@dataclass(frozen=True)
class Device:
    id: str
    user_id: str
    name: str | None
    token_hash: str
    last_seen: str | None
    created_at: str
    revoked_at: str | None = None


class DeviceRepo(BaseRepo):
    table = "devices"
    _UPDATABLE = ("name", "token_hash", "last_seen", "revoked_at")

    def _to_model(self, row) -> Device:
        return from_row(Device, row)

    def create(
        self,
        user_id: str,
        token_hash: str,
        *,
        name: str | None = None,
        device_id: str | None = None,
    ) -> Device:
        identifier = device_id or new_id("d")
        with transaction(self.conn):
            self.conn.execute(
                "INSERT INTO devices (id, user_id, name, token_hash) VALUES (?, ?, ?, ?)",
                (identifier, user_id, name, token_hash),
            )
        return self.require(self.get(identifier), "device", identifier)

    def get(self, device_id: str) -> Device | None:
        row = self._one("SELECT * FROM devices WHERE id = ?", (device_id,))
        return None if row is None else self._to_model(row)

    def get_by_token_hash(self, token_hash: str) -> Device | None:
        row = self._one("SELECT * FROM devices WHERE token_hash = ?", (token_hash,))
        return None if row is None else self._to_model(row)

    def list(self, user_id: str | None = None) -> list[Device]:
        if user_id is None:
            rows = self._all("SELECT * FROM devices ORDER BY created_at")
        else:
            rows = self._all(
                "SELECT * FROM devices WHERE user_id = ? ORDER BY created_at", (user_id,)
            )
        return [self._to_model(row) for row in rows]

    def update(self, device_id: str, **fields: Any) -> Device:
        self._update(device_id, fields, self._UPDATABLE, bump_rev=False, touch=False)
        return self.require(self.get(device_id), "device", device_id)

    def touch(self, device_id: str) -> None:
        with transaction(self.conn):
            self.conn.execute(
                "UPDATE devices SET last_seen = datetime('now') WHERE id = ?", (device_id,)
            )
