-- phase: expand
-- The Discord relay's Events worker keeps its place only as Events' opaque cursor (`position`; ADR-042 decision 7,
-- plan T7: Events no longer answers numeric positions). It stops writing the numeric `cursor` and `latest_seq`, so
-- `cursor` may be NULL from now on; a later contract migration (after this one) drops both columns.
ALTER TABLE relay_cursors ALTER COLUMN cursor DROP NOT NULL;
