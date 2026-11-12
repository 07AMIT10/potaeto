"""Credential generation and hashing for device authentication.

Raw device tokens are returned to the client exactly once; the database stores
only their SHA-256 digest. Pairing codes use the same digest so that neither
credential is recoverable from the SQLite file.
"""

from __future__ import annotations

import hashlib
import secrets

DEVICE_TOKEN_BYTES = 32
PAIRING_CODE_BYTES = 16


def hash_token(token: str) -> str:
    """Return the hex SHA-256 digest of a bearer token or pairing code."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_device_token() -> str:
    """Generate an opaque device bearer token (URL-safe, 256 bits of entropy)."""
    return secrets.token_urlsafe(DEVICE_TOKEN_BYTES)


def new_pairing_code() -> str:
    """Generate a single-use pairing code (128 bits, 32 hex characters)."""
    return secrets.token_hex(PAIRING_CODE_BYTES)
