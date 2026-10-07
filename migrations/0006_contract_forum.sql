-- phase: contract
-- after: 0005
-- T10 step 3: OpenVibe.Space owns the forum and Discord relay. The SDK waits seven days
-- after 0005 before contracting the Community schema. This removes only Community's
-- former forum tables; comments, pastes, Pulse, submissions and identity projections stay.
DELETE FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'post';
DELETE FROM pulse_items WHERE source_service = 'community' AND source_type IN ('thread', 'post');
DELETE FROM search_doc_pushes WHERE type = 'thread';
DROP TABLE IF EXISTS relay_message_map, relay_deliveries, relay_inbound_failures, relay_cursors, relay_mappings;
DROP TABLE IF EXISTS post_pastes, post_reactions, attachments, thread_votes, post_versions, posts;
DROP TABLE IF EXISTS space_chat_rooms, space_moderators, threads, categories, spaces, space_groups;
DROP FUNCTION IF EXISTS ov_hot(double precision, double precision);
