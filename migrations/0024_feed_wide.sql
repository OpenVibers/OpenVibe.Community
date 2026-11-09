-- phase: expand
-- The wide feed (owner, 11-09: "one huge feed of everything, all the data, SDK and API enabled"): Pulse items
-- carry a short text beside the title and, for Community's own posts and pastes, their first picture; post
-- attachments remember the alt text the writer gave them. The due-based public sources (server/pulse/sources.js)
-- keep their next run per source, and the Quest scan keeps when it last checked a person. Additive only.
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS text text COLLATE "C";
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS alt text COLLATE "C";

CREATE TABLE IF NOT EXISTS pulse_source_runs (
    name text COLLATE "C" PRIMARY KEY,
    next_run_at text COLLATE "C",
    last_run_at text COLLATE "C",
    last_error text COLLATE "C"
);

CREATE TABLE IF NOT EXISTS pulse_quest_people (
    subject text COLLATE "C" PRIMARY KEY,
    checked_at text COLLATE "C" NOT NULL
);
