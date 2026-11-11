-- phase: expand
-- Feed cards can carry a thumbnail and a muted video preview (server/pulse/feed.js).
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS preview_url text COLLATE "C";
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS media_ratio double precision;
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS media_length double precision;
