"""Alias module re-exporting Memory and MemoryRepo from memories."""

from app.db.repositories.memories import Memory, MemoryRepo

__all__ = ["Memory", "MemoryRepo"]
