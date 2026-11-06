-- phase: expand
-- VIS-6 review follow-up: a failed review keeps the visibility its owner asked for, so a retry that comes
-- back fine can restore it. The private column remains what the public surfaces read while pending.
ALTER TABLE pastes ADD COLUMN review_requested_visibility text COLLATE "C";
ALTER TABLE pastes ADD COLUMN review_requested_audience text COLLATE "C";
ALTER TABLE pastes ADD COLUMN review_requested_nsfw bigint;
ALTER TABLE pastes ADD COLUMN review_attempts bigint NOT NULL DEFAULT 0;
ALTER TABLE pastes ADD COLUMN review_next_at text COLLATE "C";
ALTER TABLE pastes ADD CONSTRAINT pastes_review_requested_visibility
    CHECK (review_requested_visibility IS NULL OR review_requested_visibility IN ('public', 'unlisted', 'private'));
ALTER TABLE pastes ADD CONSTRAINT pastes_review_requested_audience
    CHECK (review_requested_audience IS NULL OR review_requested_audience IN ('public', 'link', 'people', 'private'));
CREATE INDEX pastes_review_retry ON pastes (review_next_at) WHERE review_status = 'pending';
