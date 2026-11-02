-- phase: expand
-- Content labels on threads (L1, labels and choices; Contracts common.content-labels@1): what a thread carries
-- (nudity, strong language, graphic, 18+, flashing lights, spoilers), set by its author or a moderator. A label never
-- hides a thread for anyone: each reader's own choice on openvibe.network shows it, blurs it or hides it in their
-- page (Shared's ov-labels.js). `suggested` holds what an AI or a reader proposed; it changes nothing until the author
-- or a moderator confirms it. Old code never reads the column, so the default keeps every insert working (N-1 safe).
ALTER TABLE threads ADD COLUMN IF NOT EXISTS content_labels jsonb NOT NULL DEFAULT '{"labels": [], "suggested": []}'::jsonb;
