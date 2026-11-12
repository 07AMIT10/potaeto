"""Pairing-code issue and exchange.

A pairing code is a short-lived, single-use secret that a signed-in operator
hands to a new device. Exchanging it creates a device row and returns the raw
bearer token once; only the token's hash is persisted.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

from app.auth.tokens import hash_token, new_device_token, new_pairing_code
from app.db.repositories.base import transaction
from app.db.repositories.devices import DeviceRepo
from app.db.repositories.users import UserRepo

DEFAULT_CODE_TTL_SEC = 300
_CREATE_CODE_ATTEMPTS = 3


class PairingError(Exception):
    """Raised when a pairing code is unknown, expired, or already used."""


@dataclass(frozen=True)
class PairResult:
    """Outcome of a successful pairing: the token is shown only here."""

    device_id: str
    token: str
    user_id: str


class PairingService:
    """Issue and redeem pairing codes against the local SQLite store."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.devices = DeviceRepo(conn)
        self.users = UserRepo(conn)

    def create_code(self, user_id: str, ttl_sec: int = DEFAULT_CODE_TTL_SEC) -> str:
        """Create a single-use code for `user_id`, valid for `ttl_sec` seconds.

        Release 1 seeds ``u_local``, but a caller may ask for a user that does
        not exist yet (tests and first-run bootstrap use synthetic ids), so the
        user row is created on demand to keep the device foreign key satisfied.
        """
        if self.users.get(user_id) is None:
            self.users.create(name=user_id, user_id=user_id)
        expires_at = int(time.time()) + ttl_sec
        for _ in range(_CREATE_CODE_ATTEMPTS):
            code = new_pairing_code()
            try:
                with transaction(self.conn):
                    self.conn.execute(
                        "INSERT INTO pairing_codes (code_hash, user_id, expires_at) "
                        "VALUES (?, ?, ?)",
                        (hash_token(code), user_id, expires_at),
                    )
            except sqlite3.IntegrityError:
                continue
            return code
        raise PairingError("could not allocate a unique pairing code")

    def exchange(self, code: str, device_name: str) -> PairResult:
        """Redeem `code` for a new device and return its bearer token once."""
        now = int(time.time())
        # The conditional UPDATE is the single-use gate: only one caller can
        # flip `used_at` from NULL, and expired rows never match.
        with transaction(self.conn):
            updated = self.conn.execute(
                "UPDATE pairing_codes SET used_at = datetime('now') "
                "WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
                (hash_token(code), now),
            )
            if updated.rowcount != 1:
                raise PairingError("invalid or expired pairing code")
            row = self.conn.execute(
                "SELECT user_id FROM pairing_codes WHERE code_hash = ?",
                (hash_token(code),),
            ).fetchone()
            if row is None:  # pragma: no cover - the UPDATE above guarantees a row
                raise PairingError("invalid or expired pairing code")

        token = new_device_token()
        device = self.devices.create(row["user_id"], hash_token(token), name=device_name)
        return PairResult(device_id=device.id, token=token, user_id=device.user_id)
