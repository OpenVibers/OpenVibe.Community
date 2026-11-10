-- phase: expand
-- A comment can claim up to four file references uploaded through the owning service.
CREATE TABLE comment_attachments (
    media_id text COLLATE "C" PRIMARY KEY,
    ref_service text COLLATE "C" NOT NULL,
    ref_type text COLLATE "C" NOT NULL,
    ref_id text COLLATE "C" NOT NULL,
    comment_id bigint REFERENCES comments(id) ON DELETE CASCADE,
    owner_subject text COLLATE "C" NOT NULL,
    filename text COLLATE "C" NOT NULL,
    mime text COLLATE "C" NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    visibility text COLLATE "C" NOT NULL DEFAULT 'unlisted' CHECK (visibility IN ('private', 'unlisted')),
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);
CREATE INDEX comment_attachments_owner ON comment_attachments(owner_subject, created_at);
CREATE INDEX comment_attachments_comment ON comment_attachments(comment_id, media_id) WHERE comment_id IS NOT NULL;
