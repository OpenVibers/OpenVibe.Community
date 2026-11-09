-- phase: expand
-- Section reactions (rich content, stage B1): a reader says whether a SECTION of a post was good.
-- One thread per post (comment_threads), so the section id is the key: a section reaction is a row
-- of (thread, section, person, value). The counts live here, in Community, beside the comments of the
-- same post: one place holds what the readers said about a post.
--
-- Expand only: a new table and its index; nothing is dropped or rewritten. The value is 1 (good) or
-- -1 (not good); the same person reacting again replaces their row.
CREATE TABLE IF NOT EXISTS thread_section_reactions (
    thread_id bigint NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
    section_id text COLLATE "C" NOT NULL,
    subject_id text COLLATE "C" NOT NULL,
    value smallint NOT NULL CHECK (value IN (1, -1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, section_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_thread_section_reactions_thread ON thread_section_reactions(thread_id);
