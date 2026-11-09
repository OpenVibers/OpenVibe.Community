-- phase: expand
-- Statuses use ordinary moderated forum threads and opening posts, so reactions and replies reuse the post routes.
INSERT INTO spaces (slug, name, description, visibility, created_by, members_only_owner, thread_kind, style, votes, reactions, group_id, parent_id, position)
VALUES ('status', 'Status', 'Short public updates from people on OpenVibe.', 'public', 'system', NULL, 'discussion', 'feed', 0, 1, 2, NULL, 3)
ON CONFLICT (slug) DO NOTHING;
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS picture_url text COLLATE "C";
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS app_name text COLLATE "C";
