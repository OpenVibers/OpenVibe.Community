-- phase: migrate
-- T10 step 1: per-space moderators (server/forum). A person listed here for a space moderates that space
-- (thread state and status, deletes, settings, categories, members-only, its chat room) as discussion
-- staff do everywhere; the board index and creating spaces stay with staff. Additive only: one new table
-- and its index, nothing existing is touched; the previous release never reads it. People are Network
-- subjects (usr_…), never a local integer; account deletion erases a row and a subject merge moves it
-- (server/identity/account-data.js, subject-merge.js).
CREATE TABLE space_moderators (
    space_id bigint NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    subject_id text COLLATE "C" NOT NULL,
    added_by text COLLATE "C",
    created_at text COLLATE "C" NOT NULL DEFAULT ov_now(),
    PRIMARY KEY (space_id, subject_id)
);
CREATE INDEX idx_space_moderators_subject ON space_moderators (subject_id);
