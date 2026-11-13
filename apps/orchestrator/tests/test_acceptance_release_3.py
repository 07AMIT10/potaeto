"""Release 3 Comprehensive Acceptance Test Suite.

Validates the 4 core pillars of Release 3:
  1. Desktop / Native Client Notification Bridge & Platform Contracts.
  2. Multi-Device Sync Conflict Resolution & Outbox Reconciliation.
  3. Provider Usage Accounting & Catalog Stale-While-Error Resilience.
  4. Database Backup, Restore, and Integrity Verification Drill.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from starlette.testclient import TestClient

from app.catalog.cache import CatalogCache
from app.db.connection import connect_db, run_migrations
from app.db.repositories.usage import UsageRepo
from app.db.repositories.users import UserRepo
from app.main import create_app
from app.router.model_router import ModelRouter


@pytest.fixture
def clean_db():
    fd, path = tempfile.mkstemp(prefix="potaeto-r3-test-", suffix=".db")
    os.close(fd)
    conn = connect_db(path)
    run_migrations(conn)
    yield conn, path
    conn.close()
    if os.path.exists(path):
        os.unlink(path)


# -----------------------------------------------------------------------------
# Scenario 1: Desktop / Client Notification & Platform Contracts
# -----------------------------------------------------------------------------
def test_scenario_1_desktop_platform_contracts():
    """Verify Tauri desktop configuration and capability contracts."""
    root = Path(__file__).resolve().parents[3]
    tauri_conf = root / "src-tauri" / "tauri.conf.json"
    cap_default = root / "src-tauri" / "capabilities" / "default.json"
    cap_mobile = root / "src-tauri" / "capabilities" / "mobile.json"

    assert tauri_conf.is_file(), "tauri.conf.json must exist"
    with open(tauri_conf, encoding="utf-8") as f:
        conf = json.load(f)
        assert conf.get("productName") == "Potaeto"
        assert conf.get("identifier") == "com.potaeto.app"
        assert conf.get("build", {}).get("frontendDist") == "../out"

    assert cap_default.is_file(), "default.json capability must exist"
    with open(cap_default, encoding="utf-8") as f:
        cap = json.load(f)
        perms = cap.get("permissions", [])
        assert "core:default" in perms
        assert "notification:default" in perms
        assert "opener:default" in perms

    assert cap_mobile.is_file(), "mobile.json capability must exist"
    with open(cap_mobile, encoding="utf-8") as f:
        mcap = json.load(f)
        assert "android" in mcap.get("platforms", [])


# -----------------------------------------------------------------------------
# Scenario 2: Multi-Device Sync Conflict Resolution & Outbox Reconciliation
# -----------------------------------------------------------------------------
def test_scenario_2_sync_conflict_and_reconciliation(clean_db):
    """Verify backend sync conflict detection on stale_rev and outbox resolution."""
    conn, path = clean_db

    # Create user & initial entity
    users = UserRepo(conn)
    user = users.create("test-user")
    conn.execute(
        """
        INSERT INTO entities (id, user_id, name, slug, persona_json, rev)
        VALUES ('e_test_1', ?, 'Agent 1', 'agent-1', '{"tone":"calm"}', 1)
        """,
        (user.id,),
    )
    conn.commit()

    from app.db.repositories.sync import PushOperation, SyncRepo

    sync_repo = SyncRepo(conn)

    # First update: base_rev=1 -> advances rev to 2
    op1 = PushOperation(
        idempotency_key="k_op_1",
        entity_type="entity",
        entity_id="e_test_1",
        base_rev=1,
        payload={"persona_json": '{"tone":"excited"}'},
    )
    res1 = sync_repo.push("dev_1", [op1])
    assert len(res1) == 1
    assert res1[0].status == "applied"
    assert res1[0].rev == 2

    # Conflicting concurrent update from offline device with stale base_rev=1
    op_conflict = PushOperation(
        idempotency_key="k_op_conflict",
        entity_type="entity",
        entity_id="e_test_1",
        base_rev=1,
        payload={"persona_json": '{"tone":"relaxed"}'},
    )
    res_conflict = sync_repo.push("dev_2", [op_conflict])
    assert len(res_conflict) == 1
    assert res_conflict[0].status == "conflict"
    assert res_conflict[0].error == "stale_rev"
    assert res_conflict[0].rev == 2  # Current server rev returned

    # Resolved update: base_rev aligned to current server rev 2 -> succeeds
    op_resolved = PushOperation(
        idempotency_key="k_op_resolved",
        entity_type="entity",
        entity_id="e_test_1",
        base_rev=2,
        payload={"persona_json": '{"tone":"relaxed"}'},
    )
    res_resolved = sync_repo.push("dev_2", [op_resolved])
    assert len(res_resolved) == 1
    assert res_resolved[0].status == "applied"
    assert res_resolved[0].rev == 3


# -----------------------------------------------------------------------------
# Scenario 3: Provider Usage Accounting & Catalog Stale-While-Error Fallback
# -----------------------------------------------------------------------------
def test_scenario_3_provider_usage_and_catalog_fallback(clean_db):
    """Verify provider usage endpoint returns aggregates and catalog falls back safely."""
    conn, path = clean_db

    # Record sample usage rows
    usage = UsageRepo(conn)
    usage.record("openrouter", "deepseek-v4.1", tokens_in=1000, tokens_out=200, cost=0.0015)
    usage.record("openrouter", "deepseek-v4.1", tokens_in=500, tokens_out=100, cost=0.0008)
    usage.record("gemini", "gemini-2.5-flash", tokens_in=800, tokens_out=150, cost=0.0)

    summary = usage.summary()
    assert summary["total_tokens_in"] == 2300
    assert summary["total_tokens_out"] == 450
    assert summary["call_count"] == 3
    assert abs(summary["total_cost"] - 0.0023) < 1e-6
    assert "openrouter" in summary["by_provider"]
    assert "gemini" in summary["by_provider"]

    # Test Stale-While-Error Catalog Fallback
    from app.providers.base import ModelInfo
    cache = CatalogCache()
    sample_model = ModelInfo(
        id="cached-model-1",
        provider="mock",
        name="Cached Model 1",
        context_length=8192,
        max_output_tokens=2048,
        supports_tools=True,
        retention="none",
    )
    cache.set("mock", [sample_model], ttl_sec=300)

    # Refresh with failing fetcher
    def failing_fetcher():
        raise RuntimeError("Provider API rate limit 429")

    # Sync runner should catch error and return cached entries
    entries = cache.refresh_sync("mock", failing_fetcher)
    assert len(entries) == 1
    assert entries[0].id == "cached-model-1"


# -----------------------------------------------------------------------------
# Scenario 4: Database Backup, Restore, and Integrity Verification Drill
# -----------------------------------------------------------------------------
def test_scenario_4_backup_restore_drill(clean_db):
    """Verify backup.sh snapshot generation and restore.sh recovery drill."""
    conn, db_path = clean_db
    root = Path(__file__).resolve().parents[3]
    backup_script = root / "scripts" / "backup.sh"
    restore_script = root / "scripts" / "restore.sh"

    assert backup_script.is_file(), "backup.sh must exist"
    assert restore_script.is_file(), "restore.sh must exist"

    with tempfile.TemporaryDirectory(prefix="potaeto-r3-drill-") as drill_dir:
        backup_dir = Path(drill_dir) / "backups"
        restored_db = Path(drill_dir) / "restored.db"

        # 1. Run backup
        subprocess.check_call(
            [str(backup_script), "--db", db_path, "--dest", str(backup_dir), "--no-memory-git"]
        )

        # Locate generated backup file
        backups = list((backup_dir / "daily").glob("*.db.gz"))
        assert len(backups) >= 1, "Backup archive should be created"
        target_backup = str(backups[0])

        # 2. Run dry-run restore validation
        subprocess.check_call([str(restore_script), "--backup", target_backup, "--dry-run"])
        assert not restored_db.exists(), "Dry-run should not create restored file"

        # 3. Run live restore
        subprocess.check_call([str(restore_script), "--backup", target_backup, "--dest", str(restored_db)])
        assert restored_db.exists(), "Restored database must exist"

        # 4. Verify integrity and schema
        res_conn = sqlite3.connect(str(restored_db))
        cursor = res_conn.cursor()
        cursor.execute("PRAGMA integrity_check;")
        assert cursor.fetchone()[0] == "ok"

        cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
        tables = {row[0] for row in cursor.fetchall()}
        expected_core = {"users", "conversations", "messages", "memories", "approvals", "serial_events"}
        assert expected_core.issubset(tables)
        res_conn.close()
