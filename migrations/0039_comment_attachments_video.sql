-- phase: expand
-- A comment may carry a file the person uploaded through Media's composer (composer.attachment@1): a video, a
-- picture, an audio, a PDF or a text file. Media owns the bytes and answers what plays it, so the comment keeps
-- the kind, the poster, the playback (url, mime, ready), the length and the size after the rotation is applied.
-- The old file path (a med_ object) keeps its own shape: its kind is taken from its type.
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS kind text COLLATE "C";
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS url text COLLATE "C";
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS poster text COLLATE "C";
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS playback_url text COLLATE "C";
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS playback_mime text COLLATE "C";
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS playback_ready integer NOT NULL DEFAULT 0;
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS duration_s double precision;
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS width bigint;
ALTER TABLE comment_attachments ADD COLUMN IF NOT EXISTS height bigint;
UPDATE comment_attachments SET kind = CASE
    WHEN mime LIKE 'image/%' THEN 'image'
    WHEN mime LIKE 'video/%' THEN 'video'
    WHEN mime LIKE 'audio/%' THEN 'audio'
    ELSE 'file' END
WHERE kind IS NULL;
