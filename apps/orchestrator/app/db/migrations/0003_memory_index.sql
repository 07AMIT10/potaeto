-- 0003_memory_index.sql — indexer bookkeeping for markdown memory nodes.
--
-- `agent-memory` markdown stays canonical; SQLite mirrors each node so it can
-- be searched with FTS5. The indexer stores a SHA-256 of the source file in
-- `content_hash` and only rewrites a node when that hash changes, keeping
-- reindexing cheap and idempotent.
--
-- Governance lives in SQLite, not in the file: reindexing never changes
-- `status` or `user_confirmed`, so a retracted or superseded node is not
-- resurrected by a later walk of the tree.

ALTER TABLE memories ADD COLUMN content_hash TEXT;
