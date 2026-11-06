-- phase: migrate
-- The migrate-phase backfill (design 2026-11-06, step 4): every paste that existed before sharing
-- is registered once, so canView has a row for all of them.
--
--   pastes.visibility   old audience
--   public              public
--   unlisted            link     (the slug is the key)
--   private             private  (the owner's alone)
--
-- The owner is the paste's owner subject, typed as the identity contract names it: usr_… is a user,
-- gst_… a guest. A paste with no owner (an anonymous or AI paste) gets Community itself as the
-- owner: nobody can sign in as that subject, so it can never be transferred or widened by a person,
-- and its public/link audience is unaffected. Deleted pastes are not registered.
INSERT INTO shares (service, kind, resource_id, owner_subject, audience)
SELECT
    'community', 'paste', p.slug,
    CASE
        WHEN p.owner_subject LIKE 'usr\_%' THEN jsonb_build_object('type', 'user', 'id', p.owner_subject)
        WHEN p.owner_subject LIKE 'gst\_%' THEN jsonb_build_object('type', 'guest', 'id', p.owner_subject)
        ELSE jsonb_build_object('type', 'service', 'id', 'community')
    END,
    CASE p.visibility
        WHEN 'public' THEN 'public'
        WHEN 'unlisted' THEN 'link'
        ELSE 'private'
    END
FROM pastes p
WHERE p.deleted_at IS NULL
ON CONFLICT (service, kind, resource_id) DO NOTHING;
