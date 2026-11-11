-- phase: expand
-- Existing public paste discussions enter their official board. A comment keeps its id,
-- timestamp and parent; posts are a forum view linked back to those same comment rows.
INSERT INTO threads (space_id, slug, title, author_subject, origin, external_key, created_at, last_activity_at)
SELECT s.id, 'item-' || ct.id, LEFT(COALESCE(NULLIF(p.title, ''), CASE WHEN p.type = 'screenshot' THEN 'Screenshot' ELSE 'Untitled paste' END), 200),
       p.owner_subject, 'system', 'community:paste:' || p.slug, MIN(c.created_at), MAX(c.created_at)
FROM comment_threads ct
JOIN pastes p ON p.slug = ct.ref_id AND p.deleted_at IS NULL AND p.visibility = 'public' AND p.burn_after_read = 0
JOIN comments c ON c.thread_id = ct.id
JOIN spaces s ON s.slug = 'pastes'
WHERE ct.ref_service = 'community' AND ct.ref_type = 'paste' AND ct.forum_thread_id IS NULL
GROUP BY s.id, ct.id, p.slug, p.title, p.type, p.owner_subject
ON CONFLICT (space_id, external_key) WHERE external_key IS NOT NULL DO NOTHING;

UPDATE comment_threads ct SET forum_thread_id = t.id
FROM threads t JOIN spaces s ON s.id = t.space_id AND s.slug = 'pastes'
JOIN pastes p ON t.external_key = 'community:paste:' || p.slug
WHERE ct.ref_service = 'community' AND ct.ref_type = 'paste' AND ct.ref_id = p.slug
  AND p.deleted_at IS NULL AND p.visibility = 'public' AND p.burn_after_read = 0 AND ct.forum_thread_id IS NULL;

INSERT INTO posts (thread_id, origin, is_opening, body_markdown, created_at)
SELECT t.id, 'system', 1,
       '[' || REPLACE(REPLACE(t.title, '[', ''), ']', '') || '](/p/' || p.slug || ')'
           || CASE WHEN p.type = 'screenshot' THEN E'\n\n![' || REPLACE(REPLACE(t.title, '[', ''), ']', '') || '](/p/' || p.slug || '/screenshot)' ELSE '' END,
       t.created_at
FROM comment_threads ct
JOIN threads t ON t.id = ct.forum_thread_id
JOIN pastes p ON p.slug = ct.ref_id
WHERE ct.ref_service = 'community' AND ct.ref_type = 'paste'
  AND NOT EXISTS (SELECT 1 FROM posts opening WHERE opening.thread_id = t.id AND opening.is_opening = 1);

INSERT INTO posts (thread_id, author_subject, origin, body_markdown, created_at, updated_at, deleted_at, comment_id)
SELECT ct.forum_thread_id, c.author_subject, c.origin, c.message, c.created_at, c.updated_at, c.deleted_at, c.id
FROM comments c JOIN comment_threads ct ON ct.id = c.thread_id
WHERE ct.forum_thread_id IS NOT NULL AND c.forum_post_id IS NULL
ORDER BY ct.forum_thread_id, c.id
ON CONFLICT (comment_id) WHERE comment_id IS NOT NULL DO NOTHING;

UPDATE comments c SET forum_post_id = p.id FROM posts p
WHERE p.comment_id = c.id AND c.forum_post_id IS NULL;

UPDATE threads t SET reply_count = (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id AND p.is_opening = 0 AND p.deleted_at IS NULL),
    last_activity_at = (SELECT COALESCE(MAX(p.created_at), t.created_at) FROM posts p WHERE p.thread_id = t.id AND p.deleted_at IS NULL)
WHERE t.external_key LIKE 'community:paste:%';
