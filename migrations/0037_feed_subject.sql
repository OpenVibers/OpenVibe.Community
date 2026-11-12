-- phase: expand
-- The menu's Feed: a Rundown episode card keeps the streamer it is about beside the item (server/pulse/sources.js),
-- so the card can name "The Rundown" as the actor and the person as the subject. Plain JSON text; absent on every
-- older row, which is fine (the card has no subject).
ALTER TABLE pulse_items ADD COLUMN IF NOT EXISTS subject_json text COLLATE "C";
