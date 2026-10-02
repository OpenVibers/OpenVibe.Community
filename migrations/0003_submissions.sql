-- phase: expand
-- T10 plan item 8: submissions — clips, art, ideas and reports people send in for community review
-- (server/submissions). Additive only: one new table and its indexes, nothing existing is touched.
-- People are Network subjects (usr_…), never a local integer; a clip or picture stays in OpenVibe.Media
-- and only its med_ reference is kept here.
CREATE TABLE submissions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug text COLLATE "C" NOT NULL UNIQUE,
    kind text COLLATE "C" NOT NULL CHECK(kind IN ('clip', 'art', 'idea', 'report')),
    title text COLLATE "C" NOT NULL,
    body text COLLATE "C" NOT NULL DEFAULT '',
    url text COLLATE "C",
    media_ref text COLLATE "C",
    author_subject text COLLATE "C" NOT NULL,
    status text COLLATE "C" NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
    reviewer_subject text COLLATE "C",
    review_note text COLLATE "C",
    reviewed_at text COLLATE "C",
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    updated_at text COLLATE "C" NOT NULL DEFAULT ov_now()
);

-- The public list (accepted) and the review queue (pending), newest first; a person's own.
CREATE INDEX idx_submissions_status ON submissions (status, created_at DESC, id DESC);
CREATE INDEX idx_submissions_author ON submissions (author_subject, created_at DESC, id DESC);
