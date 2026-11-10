-- phase: expand
-- Exact content hash for owner-scoped paste deduplication and stable recent-list grouping.
ALTER TABLE pastes ADD COLUMN content_hash text COLLATE "C";
ALTER TABLE pastes ADD COLUMN source_hash text COLLATE "C";
CREATE INDEX idx_pastes_owner_content_hash ON pastes (owner_subject, content_hash, created_at DESC)
    WHERE owner_subject IS NOT NULL AND content_hash IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_pastes_owner_source_hash ON pastes (owner_subject, source_hash, created_at DESC)
    WHERE owner_subject IS NOT NULL AND source_hash IS NOT NULL AND deleted_at IS NULL;
