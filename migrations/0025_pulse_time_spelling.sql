-- phase: migrate
-- Pulse times in one spelling (server/pulse/store.js pulseTime): "YYYY-MM-DD HH:MM:SS" in UTC. Items from OpenVibe.Events
-- were stored as ISO ("2026-11-08T16:39:00.000Z"), which as text sorts above every same-day time written with a space,
-- so the Feed put a day's quest badges and Community's own posts below that day's events (11-09). Rewrites the ISO ones;
-- the times themselves do not change.
UPDATE pulse_items
   SET occurred_at = replace(substr(occurred_at, 1, 19), 'T', ' ')
 WHERE occurred_at LIKE '____-__-__T__:__:__%';
