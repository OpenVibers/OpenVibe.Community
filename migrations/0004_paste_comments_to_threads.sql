-- phase: migrate
-- T10 lane E job 5: paste comments move onto the typed comment threads (server/comments). From this release
-- the paste API, the paste page and /api/v1/comments all read and write the thread of ref
-- community/paste/<slug>; this copies what paste_comments holds into it so there is a single source.
--
-- Each paste_comments row becomes one comments row on its paste's thread (opened here when the paste has
-- none): the author subject (a pre-subject Network user id goes through legacy_id_map network/user), the
-- anonymous name, the message, created_at and updated_at; a deleted row stays deleted (deleted_at =
-- its updated_at) with its message scrubbed, as the comment store deletes. Replies keep their parent.
-- legacy_id_map records every copy (community/paste_comment/<old id> → comment/<new id>): that is what
-- makes this safe to run again (copied rows are skipped) and how a reply finds its parent's new id.
--
-- paste_comments is not dropped: nothing writes it any more, and it stays read-only for one release.
-- Owner check, before and after (the two numbers match once this has run):
--   SELECT (SELECT COUNT(*) FROM paste_comments) AS paste_comments,
--          (SELECT COUNT(*) FROM legacy_id_map WHERE source_system = 'community' AND source_type = 'paste_comment') AS migrated;

-- A thread for every paste with comments not copied yet. Its access id is cth_ + 22 base64url characters
-- (16 random bytes, as server/db.js makes them).
INSERT INTO comment_threads (ref_service, ref_type, ref_id, created_at, updated_at, access_id)
SELECT 'community', 'paste', p.slug, MIN(pc.created_at), MAX(pc.updated_at),
       'cth_' || rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '=')
FROM paste_comments pc
JOIN pastes p ON p.id = pc.paste_id
WHERE NOT EXISTS (SELECT 1 FROM legacy_id_map m WHERE m.source_system = 'community' AND m.source_type = 'paste_comment' AND m.source_id = pc.id::text)
GROUP BY p.slug
ON CONFLICT (ref_service, ref_type, ref_id) DO NOTHING;

-- The rows not copied yet, each with its new comment id taken from the comments sequence in the old id
-- order; the map rows and the comments go in together, in one statement. A reply's parent is either
-- copied in this same run (todo) or in an earlier one (legacy_id_map as it was before this statement: a
-- data-modifying WITH runs once, to completion, and the rest of the statement does not see its rows).
WITH todo AS (
    SELECT s.*, nextval(pg_get_serial_sequence('comments', 'id')) AS new_id
    FROM (SELECT pc.id, pc.parent_id, pc.author_subject, pc.anon_name, pc.message, pc.is_deleted, pc.created_at, pc.updated_at, p.slug
          FROM paste_comments pc
          JOIN pastes p ON p.id = pc.paste_id
          WHERE NOT EXISTS (SELECT 1 FROM legacy_id_map m WHERE m.source_system = 'community' AND m.source_type = 'paste_comment' AND m.source_id = pc.id::text)
          ORDER BY pc.id) s
), mapped AS (
    INSERT INTO legacy_id_map (source_system, source_type, source_id, target_type, target_id)
    SELECT 'community', 'paste_comment', todo.id::text, 'comment', todo.new_id::text FROM todo
)
INSERT INTO comments (id, thread_id, parent_id, author_subject, anon_name, origin, message, created_at, updated_at, deleted_at)
OVERRIDING SYSTEM VALUE
SELECT todo.new_id, th.id, COALESCE(tp.new_id, mp.target_id::bigint),
       COALESCE(um.target_id, todo.author_subject), todo.anon_name, 'user',
       CASE WHEN todo.is_deleted <> 0 THEN '' ELSE todo.message END,
       todo.created_at, todo.updated_at,
       CASE WHEN todo.is_deleted <> 0 THEN todo.updated_at END
FROM todo
JOIN comment_threads th ON th.ref_service = 'community' AND th.ref_type = 'paste' AND th.ref_id = todo.slug
LEFT JOIN todo tp ON tp.id = todo.parent_id
LEFT JOIN legacy_id_map mp ON mp.source_system = 'community' AND mp.source_type = 'paste_comment' AND mp.source_id = todo.parent_id::text
LEFT JOIN legacy_id_map um ON um.source_system = 'network' AND um.source_type = 'user' AND um.target_type = 'subject'
                          AND um.source_id = todo.author_subject AND todo.author_subject ~ '^[0-9]+$';

-- Counters from the rows, as the comment store keeps them (deleted comments not counted).
UPDATE comments c SET reply_count = (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id AND r.deleted_at IS NULL)
WHERE c.parent_id IS NULL AND c.thread_id IN (SELECT id FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'paste');
UPDATE comment_threads t SET comment_count = (SELECT COUNT(*) FROM comments c WHERE c.thread_id = t.id AND c.deleted_at IS NULL)
WHERE t.ref_service = 'community' AND t.ref_type = 'paste';
