"""SQL migration files for the Potaeto core database.

Migrations are plain `.sql` files named `NNNN_description.sql`, applied in
ascending order by :func:`app.db.connection.run_migrations`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Migration:
    version: int
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")


def discover_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Return the migration files in this package ordered by version."""
    migrations: list[Migration] = []
    for path in sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        migrations.append(Migration(version=int(path.name.split("_", 1)[0]), path=path))
    return migrations


__all__ = ["MIGRATIONS_DIR", "Migration", "discover_migrations"]
