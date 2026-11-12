"""Identifiers seeded by `0001_initial.sql`.

Release 1 has exactly one local user and one primary agent; routes and services
use these constants instead of hard-coding ids.
"""

LOCAL_USER_ID = "u_local"
PRIMARY_ENTITY_ID = "e_potaeto"
PRIMARY_ENTITY_SLUG = "potaeto"

__all__ = ["LOCAL_USER_ID", "PRIMARY_ENTITY_ID", "PRIMARY_ENTITY_SLUG"]
