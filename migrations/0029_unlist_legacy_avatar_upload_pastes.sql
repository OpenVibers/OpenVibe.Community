-- phase: expand
-- The original Live avatar route did not store metadata.kind, so the first cleanup migration missed those rows.
-- Preserve ownership and direct links while removing the old profile pictures from public paste lists.
UPDATE pastes
   SET visibility = 'unlisted', updated_at = ov_now()
 WHERE type = 'screenshot'
   AND title = 'Avatar upload'
   AND visibility = 'public';
