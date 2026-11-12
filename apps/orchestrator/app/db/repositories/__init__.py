"""Repositories for the Potaeto SQLite schema."""

from __future__ import annotations

from app.db.repositories.audit import AuditEvent, AuditRepo
from app.db.repositories.base import BaseRepo, new_id
from app.db.repositories.conversations import Conversation, ConversationRepo
from app.db.repositories.devices import Device, DeviceRepo
from app.db.repositories.entities import Entity, EntityRepo
from app.db.repositories.jobs import Job, JobRepo
from app.db.repositories.memories import Memory, MemoryRepo
from app.db.repositories.messages import Message, MessageRepo
from app.db.repositories.sync import (
    ClientOperation,
    DeviceSyncState,
    SyncChange,
    SyncRepo,
)
from app.db.repositories.tool_calls import ToolCall, ToolCallRepo
from app.db.repositories.usage import ProviderUsage, UsageRepo
from app.db.repositories.users import User, UserRepo

__all__ = [
    "AuditEvent",
    "AuditRepo",
    "BaseRepo",
    "ClientOperation",
    "Conversation",
    "ConversationRepo",
    "Device",
    "DeviceRepo",
    "DeviceSyncState",
    "Entity",
    "EntityRepo",
    "Job",
    "JobRepo",
    "Memory",
    "MemoryRepo",
    "Message",
    "MessageRepo",
    "ProviderUsage",
    "SyncChange",
    "SyncRepo",
    "ToolCall",
    "ToolCallRepo",
    "UsageRepo",
    "User",
    "UserRepo",
    "new_id",
]
