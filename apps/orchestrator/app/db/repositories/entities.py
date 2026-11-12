"""Entity (agent persona) repository."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.db.repositories.base import BaseRepo, dump_json, from_row, new_id, transaction

_JSON_FIELDS = (
    "characteristics_json",
    "appearance_json",
    "persona_json",
    "skills_json",
    "attributes_json",
)


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "entity"


@dataclass(frozen=True)
class Entity:
    id: str
    user_id: str
    name: str
    slug: str
    characteristics_json: dict[str, Any]
    appearance_json: dict[str, Any]
    persona_json: dict[str, Any]
    skills_json: list[str]
    attributes_json: dict[str, Any]
    is_public: int
    created_at: str
    updated_at: str
    rev: int
    deleted: int


class EntityRepo(BaseRepo):
    table = "entities"
    _UPDATABLE = (
        "name",
        "slug",
        *_JSON_FIELDS,
        "is_public",
        "deleted",
    )

    def _to_model(self, row) -> Entity:
        return from_row(Entity, row, _JSON_FIELDS)

    def create(
        self,
        name: str,
        *,
        user_id: str,
        slug: str | None = None,
        entity_id: str | None = None,
        characteristics: dict[str, Any] | None = None,
        appearance: dict[str, Any] | None = None,
        persona: dict[str, Any] | None = None,
        skills: list[str] | None = None,
        attributes: dict[str, Any] | None = None,
        is_public: bool = False,
    ) -> Entity:
        identifier = entity_id or new_id("e")
        with transaction(self.conn):
            self.conn.execute(
                """
                INSERT INTO entities (
                    id, user_id, name, slug, characteristics_json, appearance_json,
                    persona_json, skills_json, attributes_json, is_public
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    user_id,
                    name,
                    slug or slugify(name),
                    dump_json(characteristics or {}),
                    dump_json(appearance or {}),
                    dump_json(persona or {}),
                    dump_json(skills or []),
                    dump_json(attributes or {}),
                    1 if is_public else 0,
                ),
            )
        return self.require(self.get(identifier), "entity", identifier)

    def get(self, entity_id: str, *, include_deleted: bool = False) -> Entity | None:
        row = self._one("SELECT * FROM entities WHERE id = ?", (entity_id,))
        if row is None or (row["deleted"] and not include_deleted):
            return None
        return self._to_model(row)

    def get_by_slug(self, user_id: str, slug: str) -> Entity | None:
        row = self._one(
            "SELECT * FROM entities WHERE user_id = ? AND slug = ? AND deleted = 0",
            (user_id, slug),
        )
        return None if row is None else self._to_model(row)

    def list(
        self,
        user_id: str | None = None,
        *,
        include_deleted: bool = False,
    ) -> list[Entity]:
        where, params = self._filter_clause(
            {"user_id": user_id}, include_deleted=include_deleted
        )
        rows = self._all(f"SELECT * FROM entities{where} ORDER BY created_at", params)
        return [self._to_model(row) for row in rows]

    def update(self, entity_id: str, **fields: Any) -> Entity:
        self._update(entity_id, fields, self._UPDATABLE)
        return self.require(self.get(entity_id, include_deleted=True), "entity", entity_id)

    def delete(self, entity_id: str) -> Entity:
        """Soft-delete (tombstone) so sync peers can observe the removal."""
        return self.update(entity_id, deleted=1)
