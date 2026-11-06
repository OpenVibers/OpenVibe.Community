-- phase: expand
-- openvibe-sdk/share's additions since v0.88.0 (src/share/schema.js, verbatim and expand-only): how an item is
-- sealed, each member's key slot, the slot a transfer was offered with, and the nonce base a re-seal must beat.
-- The SDK's share store writes `lock` on every register from v0.88.0 on, so a database created from
-- migrations/0015_sharing.sql (the v0.85.0 shape) needs these columns before the v0.91.0 pin can serve a paste.
-- Expand only: nothing is dropped or rewritten, and repeating this migration is a no-op.
ALTER TABLE shares ADD COLUMN IF NOT EXISTS lock text NOT NULL DEFAULT 'none';
DO $$ BEGIN
    ALTER TABLE shares ADD CONSTRAINT shares_lock_allowed CHECK (lock IN ('none','people','password','link'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE share_members ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE share_transfers ADD COLUMN IF NOT EXISTS key_slot jsonb;
ALTER TABLE shares ADD COLUMN IF NOT EXISTS reseal_nonce_base text;
