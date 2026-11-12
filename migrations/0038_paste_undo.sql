-- phase: expand
-- Undo a delete (the owner, 2026-11-12: "a short undo time period on deletion, and undo right on it"). A paste its
-- owner deletes is hidden at once and keeps its words and picture until purge_after ('YYYY-MM-DD HH:MM:SS' UTC, the
-- same text form as ov_now()); until then the owner can restore it. A sweep (server/pastes/undo.js) clears what
-- passed its time and sets purge_after back to NULL. Every other delete (burn after read, staff, an account's
-- erasure) clears at once and never sets it.
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS purge_after text COLLATE "C";
CREATE INDEX IF NOT EXISTS pastes_purge_after ON pastes (purge_after) WHERE purge_after IS NOT NULL;
