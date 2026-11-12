import time
import pytest
from app.db.repositories.approvals import ApprovalRepo


@pytest.fixture()
def db_conn(db):
    """Alias for db fixture to support db_conn parameter name."""
    return db


def test_hash_computation_determinism():
    args_1 = {"command": "echo hello", "timeout": 30, "flags": ["-v", "-f"]}
    args_2 = {"flags": ["-v", "-f"], "timeout": 30, "command": "echo hello"}

    hash_1 = ApprovalRepo.compute_hash("run_command", args_1)
    hash_2 = ApprovalRepo.compute_hash("run_command", args_2)

    assert hash_1 == hash_2
    assert len(hash_1) == 64  # sha256 hexdigest

    # Nested dict key sorting
    nested_1 = {"options": {"b": 2, "a": 1}}
    nested_2 = {"options": {"a": 1, "b": 2}}
    assert ApprovalRepo.compute_hash("tool_x", nested_1) == ApprovalRepo.compute_hash("tool_x", nested_2)

    # Different tool name produces different hash
    assert ApprovalRepo.compute_hash("run_command_2", args_1) != hash_1
    # Different args produces different hash
    assert ApprovalRepo.compute_hash("run_command", {"command": "echo other"}) != hash_1


def test_approval_creation_and_resolution(db_conn):
    repo = ApprovalRepo(db_conn)
    action_hash = ApprovalRepo.compute_hash("run_command", {"command": "ls -la"})

    req = repo.create_request(
        tool_name="run_command",
        arguments={"command": "ls -la"},
        requested_by="u_local",
        ttl_seconds=60,
    )
    assert req["id"].startswith("appr_")
    assert req["status"] == "pending"
    assert req["action_hash"] == action_hash
    assert req["tool_name"] == "run_command"
    assert req["arguments"] == {"command": "ls -la"}
    assert req["requested_by"] == "u_local"
    assert req["expires_at"] > time.time()

    # Check pending check
    assert repo.is_approved(action_hash) is False

    # Resolve
    resolved = repo.resolve(req["id"], decision="approved", resolved_by="u_local")
    assert resolved is not None
    assert resolved["status"] == "approved"
    assert resolved["resolved_by"] == "u_local"
    assert resolved["resolved_at"] is not None
    assert repo.is_approved(action_hash) is True

    # Already resolved cannot be resolved again
    assert repo.resolve(req["id"], decision="approved", resolved_by="u_local") is None


def test_approval_rejection(db):
    repo = ApprovalRepo(db)
    action_hash = repo.compute_hash("danger_tool", {"action": "delete"})
    req = repo.create_request("danger_tool", {"action": "delete"}, "u1", ttl_seconds=120)

    resolved = repo.resolve(req["id"], decision="rejected", resolved_by="reviewer")
    assert resolved is not None
    assert resolved["status"] == "rejected"
    assert resolved["resolved_by"] == "reviewer"

    # Rejection means is_approved remains False
    assert repo.is_approved(action_hash) is False


def test_invalid_decision_raises(db):
    repo = ApprovalRepo(db)
    req = repo.create_request("tool", {"arg": "val"}, "u1")
    with pytest.raises(ValueError, match="Invalid decision"):
        repo.resolve(req["id"], decision="postpone", resolved_by="u1")


def test_expired_approval(db):
    repo = ApprovalRepo(db)
    # Create request with ttl=-10 so it's already expired
    req = repo.create_request("run_command", {"cmd": "pwd"}, "u1", ttl_seconds=-10)

    # Cannot resolve expired
    assert repo.resolve(req["id"], decision="approved", resolved_by="u1") is None
    # Cannot be approved
    assert repo.is_approved(req["action_hash"]) is False
    # Not in list_pending
    assert len(repo.list_pending()) == 0


def test_list_pending_and_get(db):
    repo = ApprovalRepo(db)
    req1 = repo.create_request("tool_1", {"x": 1}, "u1", ttl_seconds=300)
    req2 = repo.create_request("tool_2", {"y": 2}, "u2", ttl_seconds=300)
    req3 = repo.create_request("tool_3", {"z": 3}, "u1", ttl_seconds=-5)  # expired

    pending_all = repo.list_pending()
    pending_ids = [p["id"] for p in pending_all]
    assert req1["id"] in pending_ids
    assert req2["id"] in pending_ids
    assert req3["id"] not in pending_ids

    pending_u1 = repo.list_pending(requested_by="u1")
    assert len(pending_u1) == 1
    assert pending_u1[0]["id"] == req1["id"]

    # Test get
    got = repo.get(req1["id"])
    assert got is not None
    assert got["id"] == req1["id"]
    assert got["tool_name"] == "tool_1"
    assert got["arguments"] == {"x": 1}

    assert repo.get("appr_nonexistent") is None


def test_api_approvals_endpoints(client, paired_device, api_db):
    headers = {"Authorization": f"Bearer {paired_device.token}"}

    # 1. Unauthorized access
    unauth = client.get("/v1/approvals/pending")
    assert unauth.status_code == 401

    # 2. List pending (initially empty)
    res = client.get("/v1/approvals/pending", headers=headers)
    assert res.status_code == 200
    assert res.json() == []

    # 3. Create an approval request via repo
    repo = ApprovalRepo(api_db)
    req = repo.create_request("run_command", {"command": "whoami"}, "u1", ttl_seconds=300)

    # 4. List pending now shows req
    res = client.get("/v1/approvals/pending", headers=headers)
    assert res.status_code == 200
    items = res.json()
    assert len(items) == 1
    assert items[0]["id"] == req["id"]
    assert items[0]["tool_name"] == "run_command"
    assert items[0]["arguments"] == {"command": "whoami"}
    assert items[0]["status"] == "pending"

    # 5. Resolve approval via POST
    resolve_res = client.post(
        f"/v1/approvals/{req['id']}/resolve",
        json={"decision": "approved"},
        headers=headers,
    )
    assert resolve_res.status_code == 200
    resolved_body = resolve_res.json()
    assert resolved_body["id"] == req["id"]
    assert resolved_body["status"] == "approved"
    assert resolved_body["resolved_by"] == "u1"

    # 6. List pending is now empty
    res_after = client.get("/v1/approvals/pending", headers=headers)
    assert res_after.json() == []

    # 7. Resolving again returns 404
    again_res = client.post(
        f"/v1/approvals/{req['id']}/resolve",
        json={"decision": "approved"},
        headers=headers,
    )
    assert again_res.status_code == 404

    # 8. Invalid decision validation returns 422
    req2 = repo.create_request("run_command", {"command": "date"}, "u1", ttl_seconds=300)
    bad_res = client.post(
        f"/v1/approvals/{req2['id']}/resolve",
        json={"decision": "maybe"},
        headers=headers,
    )
    assert bad_res.status_code == 422
