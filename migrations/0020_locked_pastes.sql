-- phase: expand
-- Locked pastes (Locker design 2026-11-06, "The pilot, spelled out: locked pastes"). The browser seals the content
-- before it is sent; Community stores the envelope and never sees the content key. `lock_kind` repeats what the
-- envelope's header says so a list never has to open it; `envelope` is the base64 locker.envelope.v1 exactly as it
-- came; `title_shown` is the owner's choice to keep the title outside the envelope.
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS lock_kind text;
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS envelope text;
ALTER TABLE pastes ADD COLUMN IF NOT EXISTS title_shown boolean NOT NULL DEFAULT false;
DO $$ BEGIN
    ALTER TABLE pastes ADD CONSTRAINT pastes_lock_kind_allowed CHECK (lock_kind IS NULL OR lock_kind IN ('people', 'password', 'link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The SDK's share lock columns (shares.lock, key slots, reseal_nonce_base) are 0019_shares_lock_expand.sql, added by the
-- openvibe-sdk v0.91.0 pin round; this migration adds only the paste's own lock columns.
