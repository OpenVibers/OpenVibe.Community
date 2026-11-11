-- phase: expand
-- A reply stays under its top-level parent, while retaining the exact comment it answered.
ALTER TABLE comments ADD COLUMN reply_to_id bigint REFERENCES comments(id) ON DELETE SET NULL;
CREATE INDEX comments_reply_target ON comments(reply_to_id) WHERE reply_to_id IS NOT NULL;
