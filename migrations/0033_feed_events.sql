-- phase: expand
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS starts_at text COLLATE "C";
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS actor_name text COLLATE "C";
ALTER TABLE pulse_items DROP CONSTRAINT IF EXISTS pulse_items_visibility_check;
ALTER TABLE pulse_items ADD CONSTRAINT pulse_items_visibility_check CHECK (visibility IN ('public', 'followers'));

CREATE TABLE IF NOT EXISTS pulse_profile_revision (
    subject text PRIMARY KEY,
    revision bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS pulse_play_people (
    subject text PRIMARY KEY,
    checked_at text COLLATE "C" NOT NULL
);
