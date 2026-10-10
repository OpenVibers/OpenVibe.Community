-- phase: expand
-- The Discord relay's Events worker keeps its place as Events' opaque cursor (ADR-042 decision 7; plan T7 retires the
-- numeric seq): `position` holds the page's next_cursor, or the head's latest_cursor on a first start. `cursor` (the
-- numeric seq) is still written while Events sends it, so a worker of the previous release keeps its place too; a
-- later contract migration drops it once Events stops sending numeric positions.
ALTER TABLE relay_cursors ADD COLUMN IF NOT EXISTS position text;
