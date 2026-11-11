-- phase: expand
-- Test accounts (probe and manual test accounts, OpenVibe.Network users.is_test): the projection cache keeps the
-- flag next to the name, and Pulse's read excludes any item whose actor is a test account. Additive: an older
-- release never reads the column.
ALTER TABLE subject_projection ADD COLUMN IF NOT EXISTS is_test bigint NOT NULL DEFAULT 0;
