"""Durable, lease-based scheduler and the `/v1/jobs` endpoints.

The lease is the contract: exactly one worker can hold a job, an expired lease
is reclaimable, and completing a run advances `next_run` past the completed
occurrence. The misfire policy is "run once, then advance": a job that missed
several windows fires once and jumps to the next future occurrence.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from app.config import Settings
from app.db.repositories.jobs import JobRepo
from app.main import create_app
from app.scheduler.runner import JobRunner, Scheduler


def _utc_now_string(offset: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + offset).strftime("%Y-%m-%d %H:%M:%S")


def test_lease_prevents_duplicate_run(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    first = s.lease_due(now=job.next_run)
    second = s.lease_due(now=job.next_run)
    assert [j.id for j in first] == [job.id]
    assert second == []


def test_expired_lease_is_reclaimable(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    [leased] = s.lease_due(now=job.next_run)
    lease_until = datetime.fromisoformat(leased.lease_until).replace(tzinfo=UTC)
    assert s.lease_due(now=lease_until - timedelta(seconds=1)) == []
    assert [j.id for j in s.lease_due(now=lease_until + timedelta(seconds=1))] == [
        job.id
    ]


def test_completion_advances_next_run(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    previous = job.next_run
    s.lease_due(now=job.next_run)
    s.complete(job.id, "success", {"text": "done"})

    updated = JobRepo(db).get(job.id)
    assert updated.next_run > previous
    assert updated.last_run is not None
    assert updated.lease_owner is None
    assert updated.lease_until is None

    run = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchone()
    assert run["status"] == "success"
    assert run["finished_at"] is not None


def test_create_job_schedules_in_requested_timezone(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    next_run = datetime.fromisoformat(job.next_run).replace(tzinfo=UTC)
    local = next_run.astimezone(ZoneInfo("Asia/Kolkata"))
    assert (local.hour, local.minute) == (8, 0)
    assert next_run > datetime.now(UTC)


def test_missed_run_fires_once_then_advances(db):
    s = Scheduler(db)
    job = s.create_job("briefing", "0 8 * * *", "Asia/Kolkata", {"steps": []})
    three_days_ago = _utc_now_string(timedelta(days=-3))
    JobRepo(db).update(job.id, next_run=three_days_ago)

    leased = s.lease_due()
    assert [j.id for j in leased] == [job.id]
    s.complete(job.id, "success", {})

    updated = JobRepo(db).get(job.id)
    assert updated.next_run is not None
    assert updated.next_run > _utc_now_string()
    # The missed window does not queue a catch-up run.
    before_due = datetime.fromisoformat(updated.next_run).replace(
        tzinfo=UTC
    ) - timedelta(seconds=1)
    assert s.lease_due(now=before_due) == []


def test_jobs_endpoints_require_device(client):
    assert client.get("/v1/jobs").status_code == 401
    assert client.post("/v1/jobs", json={"name": "briefing"}).status_code == 401


def test_create_and_list_jobs(client, paired_device):
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    created = client.post(
        "/v1/jobs",
        headers=headers,
        json={
            "name": "briefing",
            "schedule": "0 8 * * *",
            "timezone": "Asia/Kolkata",
            "workflow": {"steps": []},
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert body["id"].startswith("j_")
    assert body["name"] == "briefing"
    assert body["next_run"]

    listed = client.get("/v1/jobs", headers=headers)
    assert listed.status_code == 200
    assert [job["id"] for job in listed.json()["jobs"]] == [body["id"]]


def test_create_job_rejects_invalid_schedule_and_timezone(client, paired_device):
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    for payload in (
        {"name": "bad-cron", "schedule": "not a cron", "timezone": "Asia/Kolkata"},
        {"name": "six-fields", "schedule": "0 0 8 * * *", "timezone": "Asia/Kolkata"},
        {"name": "bad-zone", "schedule": "0 8 * * *", "timezone": "Mars/Olympus"},
    ):
        response = client.post("/v1/jobs", headers=headers, json=payload)
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "validation_error"


# -- JobRunner ------------------------------------------------------------


async def test_due_job_runs_once_and_notifies(db):
    texts: list[str] = []

    async def notify(text: str) -> None:
        texts.append(text)

    s = Scheduler(db)
    job = s.create_job(
        "briefing",
        "0 8 * * *",
        "Asia/Kolkata",
        {"steps": [{"type": "notify", "text": "Good morning"}]},
    )
    runner = JobRunner(s, notify)
    completed = await runner.run_once(now=job.next_run)

    assert [j.id for j in completed] == [job.id]
    assert texts == ["Good morning"]
    updated = JobRepo(db).get(job.id)
    assert updated.attempt_count == 1
    assert updated.lease_owner is None
    assert updated.lease_until is None
    runs = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchall()
    assert len(runs) == 1
    assert runs[0]["status"] == "success"
    assert "Good morning" in runs[0]["output"]


async def test_leased_job_is_not_run_twice(db):
    texts: list[str] = []

    async def notify(text: str) -> None:
        texts.append(text)

    s = Scheduler(db)
    job = s.create_job(
        "briefing",
        "0 8 * * *",
        "Asia/Kolkata",
        {"steps": [{"type": "notify", "text": "once"}]},
    )
    [held] = s.lease_due(now=job.next_run)
    assert held.id == job.id

    runner = JobRunner(s, notify)
    assert await runner.run_once(now=job.next_run) == []
    assert texts == []


async def test_runner_advances_next_run(db):
    s = Scheduler(db)
    job = s.create_job(
        "briefing", "0 8 * * *", "Asia/Kolkata", {"steps": [{"type": "noop"}]}
    )
    previous = job.next_run
    [completed] = await JobRunner(s).run_once(now=job.next_run)

    assert completed.next_run > previous
    assert completed.last_run is not None
    # The completed occurrence is never due again.
    assert await JobRunner(s).run_once(now=previous) == []


async def test_notify_step_without_callback_is_a_noop(db):
    s = Scheduler(db)
    job = s.create_job(
        "briefing",
        "0 8 * * *",
        "Asia/Kolkata",
        {"steps": [{"type": "notify", "text": "nobody is listening"}]},
    )
    [completed] = await JobRunner(s).run_once(now=job.next_run)
    assert completed.enabled == 1
    run = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchone()
    assert run["status"] == "success"


async def test_unknown_step_records_error(db):
    texts: list[str] = []

    async def notify(text: str) -> None:
        texts.append(text)

    s = Scheduler(db)
    job = s.create_job(
        "briefing",
        "0 8 * * *",
        "Asia/Kolkata",
        {"steps": [{"type": "notify", "text": "before"}, {"type": "launch_missiles"}]},
    )
    previous = job.next_run
    [completed] = await JobRunner(s, notify).run_once(now=job.next_run)

    assert texts == ["before"]
    assert completed.next_run > previous
    run = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchone()
    assert run["status"] == "error"
    assert "unknown step type" in run["output"]
    assert "launch_missiles" in run["output"]


async def test_notify_failure_records_error_and_releases_the_lease(db):
    async def notify(text: str) -> None:
        raise RuntimeError("telegram is down")

    s = Scheduler(db)
    job = s.create_job(
        "briefing",
        "0 8 * * *",
        "Asia/Kolkata",
        {"steps": [{"type": "notify", "text": "hello"}]},
    )
    [completed] = await JobRunner(s, notify).run_once(now=job.next_run)

    assert completed.lease_owner is None
    assert completed.next_run > job.next_run
    run = db.execute("SELECT * FROM job_runs WHERE job_id = ?", (job.id,)).fetchone()
    assert run["status"] == "error"
    assert "telegram is down" in run["output"]


def test_app_starts_and_stops_the_job_runner_when_enabled():
    app = create_app(Settings(db_path=":memory:", scheduler_enabled=True))
    with TestClient(app) as client:
        assert app.state.job_runner is not None
        # The background poll must not block request handling.
        assert client.get("/v1/health").status_code == 200
    # Reaching here means the lifespan cancelled the task cleanly.


async def test_api_created_job_fires_once_through_the_app_runner(
    client, paired_device, api_db
):
    headers = {"Authorization": f"Bearer {paired_device.token}"}
    created = client.post(
        "/v1/jobs",
        headers=headers,
        json={
            "name": "briefing",
            "schedule": "0 8 * * *",
            "timezone": "Asia/Kolkata",
            "workflow": {"steps": [{"type": "notify", "text": "from the app"}]},
        },
    )
    assert created.status_code == 201
    job_id = created.json()["id"]
    # Simulate the job becoming due without waiting for 08:00 IST.
    JobRepo(api_db).update(job_id, next_run="2000-01-01 00:00:00")

    texts: list[str] = []

    async def notify(text: str) -> None:
        texts.append(text)

    runner = JobRunner(client.app.state.scheduler, notify)
    [completed] = await runner.run_once()

    assert completed.id == job_id
    assert texts == ["from the app"]
    run = api_db.execute(
        "SELECT * FROM job_runs WHERE job_id = ?", (job_id,)
    ).fetchone()
    assert run["status"] == "success"
