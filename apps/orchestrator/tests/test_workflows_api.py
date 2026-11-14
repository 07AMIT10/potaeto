"""Unit and integration tests for executive workflow endpoints and host monitor."""

from __future__ import annotations

import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.db.connection import connect_db, run_migrations
from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.jobs import JobRepo
from app.main import create_app


@pytest.fixture
def workflow_db():
    fd, path = tempfile.mkstemp(prefix="potaeto-wf-test-", suffix=".db")
    os.close(fd)
    conn = connect_db(path)
    run_migrations(conn)
    yield conn, path
    conn.close()
    if os.path.exists(path):
        os.unlink(path)


@pytest.fixture
def test_client(workflow_db):
    conn, path = workflow_db
    from app.config import Settings
    from app.scheduler.runner import Scheduler

    app = create_app(Settings(db_path=path, cookie_secure=False))
    app.state.db = conn
    app.state.scheduler = Scheduler(conn)

    with TestClient(app) as client:
        yield client, conn, path


def test_list_workflows(test_client):
    client, _, _ = test_client
    resp = client.get("/v1/workflows")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 5

    workflow_ids = [w["id"] for w in data]
    assert "morning-briefing" in workflow_ids
    assert "memory-consolidation" in workflow_ids
    assert "research-drill" in workflow_ids
    assert "hardware-sweep" in workflow_ids
    assert "backup-snapshot" in workflow_ids

    briefing = next(w for w in data if w["id"] == "morning-briefing")
    assert briefing["icon"] == "🌅"
    assert briefing["endpoint"] == "/v1/workflows/morning-briefing"


def test_morning_briefing_workflow(test_client):
    client, conn, _ = test_client

    # Insert sample memories and approvals
    conn.execute(
        """
        INSERT INTO memories (id, user_id, kind, content, confidence, sensitivity, scope, status, created_at, updated_at)
        VALUES ('m1', 'u1', 'observation', 'Server deployed on port 8000', 0.9, 'internal', 'device', 'active', '2026-11-14 10:00:00', '2026-11-14 10:00:00')
        """
    )
    conn.commit()

    resp = client.post("/v1/workflows/morning-briefing", json={"focus": "system"})
    assert resp.status_code == 200
    res = resp.json()

    assert res["workflow"] == "morning-briefing"
    assert res["status"] == "completed"
    assert "briefing" in res["data"]
    assert res["data"]["recent_memories_count"] >= 1
    assert "server_health" in res["data"]


def test_memory_consolidation_workflow(test_client):
    client, conn, _ = test_client

    # Seed memories of different types
    conn.execute(
        """
        INSERT INTO memories (id, user_id, kind, content, confidence, sensitivity, scope, status, created_at, updated_at)
        VALUES
          ('m1', 'u1', 'observation', 'Room temperature is 24C', 0.9, 'internal', 'device', 'active', '2026-11-14 10:00:00', '2026-11-14 10:00:00'),
          ('m2', 'u1', 'decision', 'Selected BGE-small embedding model', 0.8, 'internal', 'device', 'active', '2026-11-14 10:01:00', '2026-11-14 10:01:00')
        """
    )
    conn.commit()

    resp = client.post("/v1/workflows/memory-consolidation", json={"limit": 50})
    assert resp.status_code == 200
    res = resp.json()

    assert res["workflow"] == "memory-consolidation"
    assert res["status"] == "completed"
    assert res["data"]["scanned_count"] >= 2
    assert "clusters" in res["data"]
    assert "candidate_contradictions" in res["data"]


@pytest.mark.asyncio
async def test_research_drill_workflow(test_client):
    client, _, _ = test_client

    resp = client.post(
        "/v1/workflows/research-drill",
        json={"query": "quantum neural network", "limit": 3},
    )
    assert resp.status_code == 200
    res = resp.json()

    assert res["workflow"] == "research-drill"
    assert res["status"] == "completed"
    assert "findings" in res["data"]
    assert res["data"]["findings_count"] > 0
    assert res["data"]["grounding_verified"] is True


def test_hardware_sweep_workflow(test_client):
    client, _, _ = test_client

    resp = client.post("/v1/workflows/hardware-sweep", json={"check_boundaries": True})
    assert resp.status_code == 200
    res = resp.json()

    assert res["workflow"] == "hardware-sweep"
    assert res["status"] == "completed"
    assert "sensor_checks" in res["data"]
    assert "connected" in res["data"]
    assert res["data"]["all_normal"] is True


def test_backup_snapshot_workflow(test_client, tmp_path):
    client, conn, path = test_client

    backup_dest = tmp_path / "custom_backups"
    resp = client.post(
        "/v1/workflows/backup-snapshot",
        json={"destination": str(backup_dest)},
    )
    assert resp.status_code == 200
    res = resp.json()

    assert res["workflow"] == "backup-snapshot"
    assert res["status"] == "completed"
    assert "backup_file" in res["data"]
    assert res["data"]["integrity"] == "ok"
    assert res["data"]["tables_count"] > 0
    assert os.path.exists(res["data"]["backup_file"])


def test_monitor_status_endpoint(test_client):
    client, conn, _ = test_client

    # Add a job and an approval
    jobs = JobRepo(conn)
    jobs.create("briefing-cron", schedule="0 8 * * *", timezone="UTC", workflow={"steps": []})

    approvals = ApprovalRepo(conn)
    approvals.create_request("test_tool", {"arg": "val"}, "u1", ttl_seconds=60)

    resp = client.get("/v1/monitor/status")
    assert resp.status_code == 200
    data = resp.json()

    assert data["status"] == "healthy"
    assert "cpu_pct" in data
    assert "memory_rss_mb" in data
    assert isinstance(data["active_tasks"], list)
    assert len(data["active_tasks"]) >= 1
    assert isinstance(data["scheduled_timers"], list)
    assert len(data["scheduled_timers"]) >= 1
    assert isinstance(data["pending_approvals"], list)
    assert len(data["pending_approvals"]) >= 1
    assert data["uptime_seconds"] >= 0.0
