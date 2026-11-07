-- phase: expand
-- The public paste id (URL decisions 2026-11-07): /p/<title-slug>-<id>, where the id is 8 base58
-- characters stored once per paste. Expand-only: the column is nullable, existing rows are filled by
-- scripts/backfill-paste-public-ids.js (in batches) and reads fill one lazily; the partial unique index
-- keeps every assigned id unique without blocking the backfill.
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS public_id text COLLATE "C";

CREATE UNIQUE INDEX IF NOT EXISTS idx_pastes_public_id ON pastes(public_id) WHERE public_id IS NOT NULL;
