-- phase: migrate
-- T10 J6: Community is the only paste authority. The Live proxy that filled these columns is gone and
-- nothing reads them any more: pastes.legacy_media_id (a Media paste id), pastes.legacy_user_id (Live's
-- numeric account id) and paste_comments.legacy_media_id. The drop is a plain migrate (not a contract):
-- no code path reads them, and there is no N-1 release that needs them back, so there is nothing for the
-- SDK's 7-day contract window to protect. legacy_id_map is untouched — it is live and still backs
-- identity subject resolution.
ALTER TABLE pastes DROP COLUMN IF EXISTS legacy_media_id;
ALTER TABLE pastes DROP COLUMN IF EXISTS legacy_user_id;
ALTER TABLE paste_comments DROP COLUMN IF EXISTS legacy_media_id;
