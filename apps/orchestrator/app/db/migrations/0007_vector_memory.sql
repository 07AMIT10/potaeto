-- 0007_vector_memory.sql — sqlite-vec virtual table for 384-dimensional memory embeddings.
--
-- The sqlite-vec extension is loaded by app.db.connection (connect_db / run_migrations).
-- Memory rowids match memories.rowid, enabling hybrid KNN + FTS search with RRF.

CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
    embedding float[384]
);

-- Full-text search mirror table fts_memories (matching memories_fts)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories
    USING fts5(content, content='memories', content_rowid='rowid');

CREATE TRIGGER IF NOT EXISTS fts_memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO fts_memories(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO fts_memories(fts_memories, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS fts_memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO fts_memories(fts_memories, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO fts_memories(rowid, content) VALUES (new.rowid, new.content);
END;

INSERT INTO fts_memories(fts_memories) VALUES('rebuild');
