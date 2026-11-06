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

-- openvibe-sdk/share's own additions since v0.85.0 (src/share/schema.js, verbatim and expand-only): how an item is
-- sealed, each member's key slot, the slot a transfer was offered with, and the nonce base a re-seal must beat.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS lock text NOT NULL DEFAULT 'none';
DO $$ BEGIN
    ALTER TABLE shares ADD CONSTRAINT shares_lock_allowed CHECK (lock IN ('none', 'people', 'password', 'link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE share_members ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE share_transfers ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS reseal_nonce_base text;
