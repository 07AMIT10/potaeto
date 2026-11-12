"""Authentication: tokens, pairing, and FastAPI dependencies."""

from app.auth.dependencies import AuthContext, require_device
from app.auth.pairing import PairingError, PairingService, PairResult
from app.auth.tokens import hash_token, new_device_token, new_pairing_code

__all__ = [
    "AuthContext",
    "PairResult",
    "PairingError",
    "PairingService",
    "hash_token",
    "new_device_token",
    "new_pairing_code",
    "require_device",
]
