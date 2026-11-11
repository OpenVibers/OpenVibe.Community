-- phase: expand
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS starts_at text COLLATE "C";

CREATE TABLE IF NOT EXISTS pulse_profile_revision (
    subject text PRIMARY KEY,
    revision bigint NOT NULL
);
