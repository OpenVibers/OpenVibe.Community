-- phase: expand
-- VIS-6's last item: an unsafe-image review sorts a paste into exactly three categories.
--   fine          allowed, including nudity
--   sex_acts      never public: private and NSFW (hidden from every public list, feed and search), kept for its owner
--   minor_sexual  always blocked: quarantined with the operator's report id from OpenVibe.Vision
-- A visible image paste is 'pending' while Vision answers; a review failure leaves it private and pending,
-- never public. Text pastes are not reviewed (no image).
ALTER TABLE pastes ADD COLUMN review_category text COLLATE "C";
ALTER TABLE pastes ADD COLUMN review_status text COLLATE "C";
ALTER TABLE pastes ADD COLUMN review_report_id text COLLATE "C";
ALTER TABLE pastes ADD COLUMN reviewed_at text COLLATE "C";
ALTER TABLE pastes ADD CONSTRAINT pastes_review_category
    CHECK (review_category IS NULL OR review_category IN ('fine', 'sex_acts', 'minor_sexual'));
ALTER TABLE pastes ADD CONSTRAINT pastes_review_status
    CHECK (review_status IS NULL OR review_status IN ('pending', 'clear', 'hidden', 'quarantined'));
ALTER TABLE pastes ADD CONSTRAINT pastes_review_report
    CHECK (review_report_id IS NULL OR review_report_id ~ '^vor_[0-9A-HJKMNP-TV-Z]{26}$');
CREATE INDEX pastes_review_pending ON pastes (review_status) WHERE review_status = 'pending';
CREATE INDEX pastes_review_category ON pastes (review_category) WHERE review_category IS NOT NULL;
