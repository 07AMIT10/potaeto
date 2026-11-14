"""Comprehensive tests for vector memory, sqlite-vec, RRF hybrid search, and executive service."""

from __future__ import annotations

import math

from app.db.repositories.approvals import ApprovalRepo
from app.db.repositories.jobs import JobRepo
from app.db.repositories.memories import MemoryRepo
from app.db.repositories.sync import PushOperation, SyncRepo
from app.memory.embeddings import (
    EMBEDDING_DIM,
    cosine_similarity,
    deserialize_float32,
    generate_embedding,
    serialize_float32,
)
from app.services.executive import ExecutiveService


def test_embedding_dimensions_and_normalization() -> None:
    vec = generate_embedding("Autonomous executive engine for Potaeto")
    assert len(vec) == EMBEDDING_DIM
    norm = math.sqrt(sum(x * x for x in vec))
    assert abs(norm - 1.0) < 1e-4

    # Empty text yields zero vector
    empty_vec = generate_embedding("")
    assert len(empty_vec) == EMBEDDING_DIM
    assert sum(empty_vec) == 0.0


def test_embedding_deterministic_and_similarity() -> None:
    text1 = "Alex likes drinking green matcha tea in the morning"
    text2 = "Alex likes drinking green matcha tea in the morning"
    text3 = "Alex enjoys warm matcha green tea every morning"
    text4 = "The PostgreSQL database is deployed on port 5432"

    v1 = generate_embedding(text1)
    v2 = generate_embedding(text2)
    v3 = generate_embedding(text3)
    v4 = generate_embedding(text4)

    # Determinism: exact same string -> exact same vector
    assert v1 == v2
    assert abs(cosine_similarity(v1, v2) - 1.0) < 1e-6

    # Semantically close sentences have high similarity
    sim_close = cosine_similarity(v1, v3)
    sim_far = cosine_similarity(v1, v4)
    assert sim_close > sim_far
    assert sim_close > 0.15


def test_embedding_serialization_roundtrip() -> None:
    vec = [0.12345] * EMBEDDING_DIM
    raw = serialize_float32(vec)
    assert len(raw) == EMBEDDING_DIM * 4
    unpacked = deserialize_float32(raw)
    assert len(unpacked) == EMBEDDING_DIM
    for a, b in zip(vec, unpacked):
        assert abs(a - b) < 1e-5


def test_vec0_virtual_table_creation_and_knn(db) -> None:
    # Verify vec_memories virtual table is active
    rows = db.execute("SELECT name FROM sqlite_master WHERE name = 'vec_memories'").fetchall()
    assert len(rows) == 1

    vec1 = serialize_float32(generate_embedding("Apples are tasty fruits"))
    vec2 = serialize_float32(generate_embedding("Quantum computing and qubits"))

    db.execute("INSERT INTO vec_memories (rowid, embedding) VALUES (1, ?)", (vec1,))
    db.execute("INSERT INTO vec_memories (rowid, embedding) VALUES (2, ?)", (vec2,))

    # Query KNN with exact match for vec1
    knn = db.execute(
        "SELECT rowid, distance FROM vec_memories WHERE embedding MATCH ? AND k = 1",
        (vec1,),
    ).fetchall()
    assert len(knn) == 1
    assert knn[0][0] == 1
    assert abs(knn[0][1] - 0.0) < 1e-4


def test_memory_repo_indexes_and_updates_vectors(db) -> None:
    repo = MemoryRepo(db)

    # 1. Create indexes into vec_memories
    mem = repo.create("u1", "The microservice is listening on port 8080")
    row = db.execute("SELECT rowid FROM memories WHERE id = ?", (mem.id,)).fetchone()
    assert row is not None
    rowid = row[0]

    vec_row = db.execute("SELECT rowid FROM vec_memories WHERE rowid = ?", (rowid,)).fetchone()
    assert vec_row is not None
    assert vec_row[0] == rowid

    # 2. Update content re-indexes vector
    repo.update(mem.id, content="The microservice is listening on port 9090")
    vec_row2 = db.execute("SELECT rowid FROM vec_memories WHERE rowid = ?", (rowid,)).fetchone()
    assert vec_row2 is not None

    # 3. Soft-delete removes row from vec_memories
    repo.delete(mem.id)
    vec_deleted = db.execute("SELECT rowid FROM vec_memories WHERE rowid = ?", (rowid,)).fetchone()
    assert vec_deleted is None


def test_hybrid_search_rrf_scoring_and_ranking(db) -> None:
    repo = MemoryRepo(db)

    # Insert test memories
    # Target query: "matcha tea"
    # m_dual: matches both FTS keyword ("matcha tea") and vector semantics
    m_dual = repo.create(
        "u1",
        "Alex loves drinking organic matcha tea every morning for focus",
        confidence=0.9,
    )
    # m_fts_only: contains the keyword "matcha" in an unrelated context
    repo.create(
        "u1",
        "Supermarket inventory listing: matcha tin box $12",
        confidence=0.6,
    )
    # m_semantic_only: semantic tea concept without the word "matcha"
    repo.create(
        "u1",
        "Japanese powdered green beverage provides healthy caffeine and antioxidants",
        confidence=0.7,
    )
    # m_unrelated: completely unrelated
    repo.create(
        "u1",
        "Deploy the backend orchestrator container to AWS us-east-1",
        confidence=0.8,
    )

    # Search with RRF k=60
    results = repo.hybrid_search("matcha tea", top_k=5, rrf_k=60, user_id="u1")
    assert len(results) >= 2

    # m_dual should be top-ranked due to reciprocal rank fusion of vector + FTS
    assert results[0].id == m_dual.id
    assert results[0].rrf_score is not None

    # Scores should be strictly descending
    scores = [m.rrf_score for m in results if m.rrf_score is not None]
    assert scores == sorted(scores, reverse=True)

    # Test top score calculation: 1/(60+1) + 1/(60+1) approx 0.03278
    top_score = results[0].rrf_score
    assert top_score > (1.0 / 61.0)


def test_sync_memory_ingestion_vector_indexing(db) -> None:
    sync_repo = SyncRepo(db)
    mem_id = "mem_sync_test_01"

    op = PushOperation(
        idempotency_key="sync_mem_key_01",
        entity_type="memory",
        entity_id=mem_id,
        payload={"content": "Synchronized personal note from mobile client", "confidence": 0.85},
    )

    res = sync_repo.push("dev_01", [op])
    assert res[0].status == "applied"

    # Verify memory exists and is vector-indexed
    repo = MemoryRepo(db)
    mem = repo.get(mem_id)
    assert mem is not None
    assert mem.content == "Synchronized personal note from mobile client"

    row = db.execute("SELECT rowid FROM memories WHERE id = ?", (mem_id,)).fetchone()
    assert row is not None
    vec_row = db.execute("SELECT rowid FROM vec_memories WHERE rowid = ?", (row[0],)).fetchone()
    assert vec_row is not None


def test_executive_morning_briefing(db) -> None:
    # 1. Setup active job
    JobRepo(db).create("Daily Backup", schedule="0 2 * * *", enabled=True)

    # 2. Setup pending approval
    ApprovalRepo(db).create_request(
        "terminal_exec",
        {"cmd": "systemctl restart potaeto"},
        requested_by="agent_test",
        ttl_seconds=600,
    )

    # 3. Setup recent high-importance memory
    repo = MemoryRepo(db)
    repo.create(
        "u1",
        "Security firewall updated to block port 22 externally",
        confidence=0.95,
        kind="fact",
    )

    exec_svc = ExecutiveService(db)
    briefing = exec_svc.generate_morning_briefing("u1", hours=24)

    assert "Executive Morning Briefing" in briefing["briefing"]
    assert "System Vitals" in briefing["briefing"]
    assert "Pending Approvals" in briefing["briefing"]
    assert "Active Tasks & Schedules" in briefing["briefing"]
    assert "High-Importance Memories" in briefing["briefing"]

    assert briefing["pending_approvals_count"] == 1
    assert briefing["active_tasks_count"] == 1
    assert briefing["high_importance_memories_count"] >= 1
    assert briefing["vitals"] is not None


def test_executive_memory_consolidation(db) -> None:
    repo = MemoryRepo(db)

    # Near-duplicates (merger candidates)
    repo.create(
        "u1",
        "Alex prefers drinking oat milk in black coffee",
        confidence=0.5,
        user_confirmed=False,
    )
    repo.create(
        "u1",
        "Alex prefers drinking oat milk in his black coffee",
        confidence=0.5,
        user_confirmed=False,
    )

    # Contradiction candidates
    repo.create(
        "u1",
        "The proxy cache service is enabled on port 8080",
        confidence=0.5,
        user_confirmed=False,
    )
    repo.create(
        "u1",
        "The proxy cache service is disabled on port 8080",
        confidence=0.5,
        user_confirmed=False,
    )

    exec_svc = ExecutiveService(db)
    cons = exec_svc.consolidate_memories("u1")

    assert cons["candidates_analyzed"] >= 4
    assert cons["clusters_count"] >= 1

    # Should detect the negation opposition contradiction
    contradiction_types = [c["conflict_type"] for c in cons["contradictions"]]
    assert "negation_opposition" in contradiction_types or len(cons["contradictions"]) >= 1


def test_executive_and_memory_api_routes(client, paired_device) -> None:
    headers = {"Authorization": f"Bearer {paired_device.token}"}

    # 1. Executive Morning Briefing
    res_briefing = client.post(
        "/v1/executive/briefing",
        json={"hours": 48},
        headers=headers,
    )
    assert res_briefing.status_code == 200
    data_b = res_briefing.json()
    assert "briefing" in data_b
    assert "vitals" in data_b
    assert "pending_approvals" in data_b

    # 2. Executive Memory Consolidation
    res_cons = client.post(
        "/v1/executive/consolidate",
        json={"cluster_threshold": 0.6, "limit": 20},
        headers=headers,
    )
    assert res_cons.status_code == 200
    data_c = res_cons.json()
    assert "candidates_analyzed" in data_c
    assert "clusters" in data_c
    assert "mergers" in data_c
    assert "contradictions" in data_c

    # 3. Hybrid Memory Search route
    res_search = client.get(
        "/v1/memory/search?q=test&limit=5",
        headers=headers,
    )
    assert res_search.status_code == 200
    data_s = res_search.json()
    assert "memories" in data_s
