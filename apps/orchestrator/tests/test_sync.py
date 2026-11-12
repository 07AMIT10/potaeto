"""Server-authoritative sync: idempotent pushes, cursors, acks, and tombstones."""

from app.db.repositories.entities import EntityRepo


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _message_op(key: str, message_id: str, content: str = "hello") -> dict:
    return {
        "idempotency_key": key,
        "entity_type": "message",
        "entity_id": message_id,
        "base_rev": 0,
        "payload": {"content": content},
    }


def test_push_is_idempotent(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    repo = SyncRepo(db)
    op = PushOperation("k1", "message", "m1", 0, {"content": "hello"})
    first = repo.push("d1", [op])
    second = repo.push("d1", [op])
    assert first[0].status == "applied"
    assert second[0].status == "duplicate"
    assert first[0].seq == second[0].seq
    assert db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1


def test_stale_base_rev_returns_conflict(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    entity = EntityRepo(db).create("Biscuit", user_id="u_local")
    repo = SyncRepo(db)
    result = repo.push(
        "d1", [PushOperation("k1", "entity", entity.id, 0, {"name": "Impostor"})]
    )[0]
    assert result.status == "conflict"
    assert result.error == "stale_rev"
    assert result.rev == entity.rev
    assert EntityRepo(db).get(entity.id).name == "Biscuit"

    # A retry of the same key replays the stored conflict instead of writing.
    replay = repo.push(
        "d1", [PushOperation("k1", "entity", entity.id, 0, {"name": "Impostor"})]
    )[0]
    assert replay.status == "conflict"
    assert replay.error == "stale_rev"
    assert EntityRepo(db).get(entity.id).name == "Biscuit"


def test_entity_push_applies_and_records_change(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    entity = EntityRepo(db).create("Biscuit", user_id="u_local")
    repo = SyncRepo(db)
    result = repo.push(
        "d1", [PushOperation("k2", "entity", entity.id, entity.rev, {"name": "Spud"})]
    )[0]
    assert result.status == "applied"
    assert result.error is None
    assert result.rev == entity.rev + 1
    assert EntityRepo(db).get(entity.id).name == "Spud"

    change = repo.get_changes(result.seq - 1, 10)[0]
    assert (change.entity_type, change.entity_id) == ("entity", entity.id)
    assert change.seq == result.seq
    assert change.payload_json["name"] == "Spud"


def test_entity_tombstone_is_recorded_as_delete(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    entity = EntityRepo(db).create("Biscuit", user_id="u_local")
    repo = SyncRepo(db)
    result = repo.push(
        "d1", [PushOperation("k2", "entity", entity.id, entity.rev, {"deleted": 1})]
    )[0]
    assert result.status == "applied"
    assert EntityRepo(db).get(entity.id) is None

    change = repo.get_changes(result.seq - 1, 10)[0]
    assert change.operation == "delete"
    assert change.payload_json["deleted"] == 1


def test_unknown_entity_type_is_unsupported(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    result = SyncRepo(db).push("d1", [PushOperation("k1", "widget", "w1", 0, {})])[0]
    assert result.status == "unsupported"
    assert result.error == "unsupported_entity_type"


def test_duplicate_message_id_under_new_key_is_a_duplicate(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    repo = SyncRepo(db)
    first = repo.push(
        "d1", [PushOperation("k1", "message", "m1", 0, {"content": "hi"})]
    )[0]
    second = repo.push(
        "d1", [PushOperation("k2", "message", "m1", 0, {"content": "hi"})]
    )[0]
    assert first.status == "applied"
    # Message ids are client-generated and append-only: a re-push under a new
    # idempotency key is the same logical message, not a stale_rev conflict.
    assert second.status == "duplicate"
    assert second.error is None
    assert second.rev == first.rev
    assert second.seq == first.seq
    assert db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1


def test_outbox_push_after_stream_persisted_the_message_is_duplicate(db):
    """A failed stream must not wedge the outbox on a stale_rev conflict.

    The chat loop persists the user turn directly (no client_operations
    record). If the stream then fails on the client, the same message id is
    pushed from the outbox with ``base_rev=0``; that has to read as a
    duplicate so ``flush()`` clears the entry instead of retrying forever.
    """
    from app.db.repositories.conversations import ConversationRepo
    from app.db.repositories.messages import MessageRepo
    from app.db.repositories.sync import PushOperation, SyncRepo

    conversation = ConversationRepo(db).ensure_conversation("u_local", "e_potaeto")
    MessageRepo(db).append(
        conversation.id, "u_local", "user", "hi", message_id="m-stream"
    )

    repo = SyncRepo(db)
    result = repo.push(
        "d1",
        [PushOperation("k-outbox", "message", "m-stream", 0, {"content": "hi"})],
    )[0]
    assert result.status == "duplicate"
    assert result.error is None
    assert result.rev == 1
    assert db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1
    # No new change-log entry: the message was already persisted.
    assert repo.get_changes(0, 10) == []


def test_message_id_with_matching_rev_is_duplicate(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    repo = SyncRepo(db)
    first = repo.push(
        "d1", [PushOperation("k1", "message", "m1", 0, {"content": "hi"})]
    )[0]
    second = repo.push(
        "d1", [PushOperation("k2", "message", "m1", 1, {"content": "hi"})]
    )[0]
    assert second.status == "duplicate"
    assert second.seq == first.seq
    assert db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1


def test_message_push_ignores_client_supplied_user(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    SyncRepo(db).push(
        "d1",
        [PushOperation("k1", "message", "m1", 0, {"content": "hi", "user_id": "u_x"})],
    )
    row = db.execute("SELECT user_id FROM messages WHERE id = ?", ("m1",)).fetchone()
    assert row["user_id"] == "u_local"


def test_entity_push_rejects_unknown_field(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    entity = EntityRepo(db).create("Biscuit", user_id="u_local")
    repo = SyncRepo(db)
    result = repo.push(
        "d1", [PushOperation("k1", "entity", entity.id, entity.rev, {"bogus": 1})]
    )[0]
    assert result.status == "error"
    assert result.error == "invalid_payload"
    assert repo.get_changes(0, 10) == []

    # The failed operation does not poison the connection for later pushes.
    retry = repo.push(
        "d1", [PushOperation("k2", "entity", entity.id, entity.rev, {"name": "Spud"})]
    )[0]
    assert retry.status == "applied"


def test_entity_push_integrity_error_keeps_transaction_usable(db):
    from app.db.repositories.sync import PushOperation, SyncRepo

    first = EntityRepo(db).create("Biscuit", user_id="u_local")
    second = EntityRepo(db).create("Gravy", user_id="u_local")
    repo = SyncRepo(db)
    result = repo.push(
        "d1",
        [PushOperation("k1", "entity", second.id, second.rev, {"slug": first.slug})],
    )[0]
    assert result.status == "error"
    assert result.error == "integrity_error"
    assert EntityRepo(db).get(second.id).name == "Gravy"
    assert repo.get_changes(0, 10) == []

    retry = repo.push(
        "d1",
        [PushOperation("k2", "entity", second.id, second.rev, {"name": "Biscuit"})],
    )[0]
    assert retry.status == "applied"


def test_seq_is_monotonic_and_cursor_works(db):
    from app.db.repositories.sync import SyncRepo

    repo = SyncRepo(db)
    s1 = repo.record_change("message", "m1", "insert", {})
    s2 = repo.record_change("message", "m2", "insert", {})
    assert s2 == s1 + 1
    assert [c.seq for c in repo.get_changes(s1, 10)] == [s2]
    assert repo.get_changes(s2, 10) == []


def test_ack_is_per_device(db):
    from app.db.repositories.sync import SyncRepo

    repo = SyncRepo(db)
    assert repo.last_ack("d1") == 0
    repo.ack("d1", 5)
    repo.ack("d2", 3)
    assert repo.last_ack("d1") == 5
    assert repo.last_ack("d2") == 3


def test_ack_never_moves_backwards(db):
    from app.db.repositories.sync import SyncRepo

    repo = SyncRepo(db)
    repo.ack("d1", 5)
    repo.ack("d1", 2)
    assert repo.last_ack("d1") == 5


def test_sync_endpoints_require_device_auth(client):
    assert client.get("/v1/sync").status_code == 401
    assert client.post("/v1/sync/push", json={"operations": []}).status_code == 401
    assert client.post("/v1/sync/ack", json={"seq": 0}).status_code == 401


def test_push_then_pull_round_trip(client, paired_device, api_db):
    headers = _auth(paired_device.token)
    op = _message_op("k1", "m1")

    pushed = client.post("/v1/sync/push", json={"operations": [op]}, headers=headers)
    assert pushed.status_code == 200
    result = pushed.json()["results"][0]
    assert result["status"] == "applied"
    assert result["seq"] > 0

    pulled = client.get("/v1/sync?after_seq=0", headers=headers).json()
    assert pulled["has_more"] is False
    assert pulled["next_seq"] == result["seq"]
    change = pulled["changes"][-1]
    assert change["seq"] == result["seq"]
    assert change["entity_type"] == "message"
    assert change["entity_id"] == "m1"
    assert change["operation"] == "insert"
    assert change["payload"]["content"] == "hello"

    replay = client.post("/v1/sync/push", json={"operations": [op]}, headers=headers)
    assert replay.json()["results"][0]["status"] == "duplicate"
    assert replay.json()["results"][0]["seq"] == result["seq"]
    assert api_db.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 1


def test_pull_paginates_with_limit(client, paired_device):
    headers = _auth(paired_device.token)
    for index in range(3):
        op = _message_op(f"k{index}", f"m{index}", f"hello {index}")
        response = client.post(
            "/v1/sync/push", json={"operations": [op]}, headers=headers
        )
        assert response.json()["results"][0]["status"] == "applied"

    first = client.get("/v1/sync?after_seq=0&limit=2", headers=headers).json()
    assert len(first["changes"]) == 2
    assert first["has_more"] is True

    second = client.get(
        f"/v1/sync?after_seq={first['next_seq']}&limit=2", headers=headers
    ).json()
    assert len(second["changes"]) == 1
    assert second["has_more"] is False
    assert second["next_seq"] > first["next_seq"]


def test_ack_endpoint_uses_authenticated_device(client, paired_device, api_db):
    from app.db.repositories.sync import SyncRepo

    headers = _auth(paired_device.token)
    response = client.post(
        "/v1/sync/ack",
        json={"device_id": "someone-else", "seq": 7},
        headers=headers,
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}

    repo = SyncRepo(api_db)
    assert repo.last_ack(paired_device.device_id) == 7
    assert repo.last_ack("someone-else") == 0


def test_push_rejects_stale_entity_over_http(client, paired_device, api_db):
    entity = EntityRepo(api_db).create("Biscuit", user_id=paired_device.user_id)
    headers = _auth(paired_device.token)
    op = {
        "idempotency_key": "k1",
        "entity_type": "entity",
        "entity_id": entity.id,
        "base_rev": 0,
        "payload": {"name": "Impostor"},
    }
    response = client.post("/v1/sync/push", json={"operations": [op]}, headers=headers)
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["status"] == "conflict"
    assert result["error"] == "stale_rev"
    assert result["rev"] == entity.rev
