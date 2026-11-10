-- phase: expand
-- Profile pictures belong to their owner's avatar store. Keep the old rows and their owners, but remove them from
-- public paste lists and preserve their direct links for the owner and existing references.
UPDATE pastes
   SET visibility = 'unlisted', updated_at = ov_now()
 WHERE type = 'screenshot'
   AND title = 'Avatar upload'
   AND visibility = 'public'
   AND metadata IS NOT NULL
   AND (metadata::jsonb ->> 'kind') = 'avatar';
