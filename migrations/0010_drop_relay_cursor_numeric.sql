-- phase: contract
-- after: 0007
-- The Discord relay's Events worker keeps its place only as Events' opaque cursor (`position`, 0006). Since 0007
-- (2026-10-10) nothing writes the numeric `cursor` or `latest_seq` and nothing reads them (Events no longer answers
-- numeric positions, plan T7), and the release before this one already ran without them. This drops both columns.
ALTER TABLE relay_cursors DROP COLUMN IF EXISTS cursor;
ALTER TABLE relay_cursors DROP COLUMN IF EXISTS latest_seq;
