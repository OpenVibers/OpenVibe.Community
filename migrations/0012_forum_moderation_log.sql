-- phase: expand
-- A public moderation log per space (market outcome 5: "we publish what our moderation did and why").
-- Every moderator action (lock, unlock, pin, unpin, hide, delete, status) writes one row in the same
-- transaction as the action. The public row names the role only (staff, moderator, owner, automatic),
-- never the moderator's Network subject: a removed thread keeps its id and title here for rendering,
-- and a hard-deleted thread or post sets its reference to NULL.
CREATE TABLE forum_moderation_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    space_id bigint NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    thread_id bigint REFERENCES threads(id) ON DELETE SET NULL,
    post_id bigint REFERENCES posts(id) ON DELETE SET NULL,
    action text COLLATE "C" NOT NULL CHECK(action IN ('lock', 'unlock', 'pin', 'unpin', 'hide', 'delete', 'status')),
    rule text COLLATE "C",
    reason text COLLATE "C" CHECK(reason IS NULL OR char_length(reason) <= 280),
    actor_role text COLLATE "C" NOT NULL CHECK(actor_role IN ('moderator', 'owner', 'staff', 'automatic')),
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);

CREATE INDEX idx_forum_moderation_log_space ON forum_moderation_log (space_id, created_at DESC, id DESC);
