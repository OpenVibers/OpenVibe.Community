-- phase: expand
-- Part 3: map each typed item discussion to its official board thread, and retain source
-- comment ids on forum posts so the two views can refer to the same ordered discussion.
ALTER TABLE comment_threads ADD COLUMN IF NOT EXISTS forum_thread_id bigint REFERENCES threads(id) ON DELETE SET NULL;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS forum_post_id bigint REFERENCES posts(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS comment_id bigint REFERENCES comments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS posts_comment_id_unique ON posts(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS comment_threads_forum_thread_id_idx ON comment_threads(forum_thread_id) WHERE forum_thread_id IS NOT NULL;

INSERT INTO space_groups (slug, name, description, position)
VALUES ('openvibe-items', 'OpenVibe items', 'Talk about pictures, videos, clips, and pastes shared across OpenVibe.', 900)
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO spaces (slug, name, description, visibility, created_by, style, votes, reactions, group_id, position, thread_kind)
SELECT b.slug, b.name, b.description, 'public', 'system:comments-forum', 'forum', 0, 0, g.id, b.position, 'discussion'
FROM space_groups g
CROSS JOIN (VALUES
  ('pictures', 'Pictures', 'Discuss pictures shared on OpenVibe.', 1),
  ('videos', 'Videos', 'Discuss videos shared on OpenVibe.', 2),
  ('clips', 'Clips', 'Discuss clips shared on OpenVibe.', 3),
  ('pastes', 'Pastes', 'Discuss pastes shared on OpenVibe.', 4)
) AS b(slug, name, description, position)
WHERE g.slug = 'openvibe-items'
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
  visibility = 'public', style = 'forum', votes = 0, reactions = 0, group_id = EXCLUDED.group_id,
  position = EXCLUDED.position;
