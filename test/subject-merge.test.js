'use strict';
/**
 * network.subject.merged in Community (roadmap WS-B task 5, ADR-029): a signed delivery makes the folded-in subject's
 * pastes, comments, threads, posts and pulse items the survivor's; per-item likes, votes and
 * reactions move unless the survivor has one there (then the other is dropped and the cached count or score is
 * recomputed); game progress and blocks keep the survivor's, and blocking oneself is dropped. A redelivery changes
 * nothing; another source or a malformed payload is ignored. Community subscribes to the topic.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { openDb } = require('../server/db');
const { createPulseConsumer, TOPICS } = require('../server/pulse/consumer');
const SECRET = `whsec_${'ef'.repeat(32)}`;
const db = openDb(':memory:');
const app = express();
app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], log: { error() {}, log() {}, warn() {} } }).router);
const KEEP = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1', FOLD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2', OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
const MERGE = 'mrg_01JAB2C3D4E5F6G7H8J9K0MNP4';
const evt = (over = {}) => ({ event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN09', event_type: 'network.subject.merged', version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
    subject: { type: 'user', id: KEEP }, actor: { type: 'user', id: KEEP },
    payload: { merge_id: MERGE, from: FOLD, into: KEEP, merged_at: new Date().toISOString(), initiated_by: 'person' }, ...over });

// What the folded-in account left in Community.
db.prepare("INSERT INTO pastes (id, slug, owner_subject, likes) VALUES (1, 'p1', ?, 2), (2, 'p2', ?, 1)").run(FOLD, OTHER);
db.prepare('INSERT INTO paste_likes (paste_id, subject_id) VALUES (1, ?), (1, ?), (2, ?)').run(FOLD, KEEP, FOLD);   // paste 1: both liked
db.prepare("INSERT INTO comment_threads (id, ref_service, ref_type, ref_id) VALUES (1, 'live', 'vod', '9')").run();
db.prepare("INSERT INTO comments (id, thread_id, message, author_subject, score, upvotes, downvotes) VALUES (1, 1, 'hi', ?, 2, 2, 0)").run(OTHER);
db.prepare('INSERT INTO comment_votes (comment_id, subject_id, value) VALUES (1, ?, 1), (1, ?, 1)').run(FOLD, KEEP);
db.prepare("INSERT INTO spaces (id, slug, name) VALUES (901, 'merge-test', 'Merge test')").run();
db.prepare("INSERT INTO threads (id, space_id, slug, title, author_subject, score) VALUES (1, 901, 't1', 'T1', ?, 1)").run(FOLD);
db.prepare('INSERT INTO thread_votes (thread_id, subject_id, value) VALUES (1, ?, 1)').run(FOLD);
db.prepare("INSERT INTO posts (id, thread_id, body_markdown, author_subject) VALUES (1, 1, 'hello', ?)").run(FOLD);
db.prepare("INSERT INTO post_reactions (post_id, subject_id, reaction) VALUES (1, ?, 'fire'), (1, ?, 'heart')").run(FOLD, KEEP);
db.prepare("INSERT INTO game_progress (subject_id, level, updated_at) VALUES (?, 3, '2026-09-27'), (?, 5, '2026-09-27')").run(FOLD, KEEP);
require('../server/identity/blocks').ensureSchema(db);
db.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(FOLD, OTHER, FOLD, KEEP);

(async () => {
    assert.ok(TOPICS.includes('network.subject.merged'), 'Community subscribes to merges');
    const srv = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const post = (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(`http://127.0.0.1:${srv.address().port}/internal/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    };
    try {
        let r = await post(evt({ source: 'live' }));
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'ignored:source']);
        r = await post(evt({ event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN08', payload: { merge_id: 'nope', from: FOLD, into: KEEP } }));
        assert.strictEqual(r.json.outcome, 'ignored:payload');

        r = await post(evt());
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'merge:applied']);
        const owner = (sql, ...a) => db.prepare(sql).get(...a);
        assert.strictEqual(owner('SELECT owner_subject AS s FROM pastes WHERE id = 1').s, KEEP);
        assert.strictEqual(owner('SELECT author_subject AS a FROM threads WHERE id = 1').a, KEEP);
        assert.strictEqual(owner('SELECT author_subject AS a FROM posts WHERE id = 1').a, KEEP);
        // Likes: paste 1 had both (one dropped, count 1); paste 2's like moved.
        assert.deepStrictEqual(db.prepare('SELECT paste_id AS p, subject_id AS s FROM paste_likes ORDER BY p').all().map((x) => [x.p, x.s]), [[1, KEEP], [2, KEEP]]);
        assert.strictEqual(owner('SELECT likes FROM pastes WHERE id = 1').likes, 1, 'the cached count follows the rows');
        // Votes: comment 1 had both (score recomputed to 1); thread 1's vote moved.
        assert.deepStrictEqual(owner('SELECT score, upvotes, downvotes FROM comments WHERE id = 1'), { score: 1, upvotes: 1, downvotes: 0 });
        assert.deepStrictEqual(db.prepare('SELECT subject_id AS s FROM thread_votes').all().map((x) => x.s), [KEEP]);
        assert.deepStrictEqual(db.prepare('SELECT subject_id AS s, reaction FROM post_reactions').all(), [{ s: KEEP, reaction: 'heart' }], 'the survivor\'s reaction stays');
        assert.deepStrictEqual(db.prepare('SELECT subject_id AS s, level FROM game_progress').all(), [{ s: KEEP, level: 5 }]);
        assert.deepStrictEqual(db.prepare('SELECT blocker_subject AS a, blocked_subject AS b FROM network_blocks').all(), [{ a: KEEP, b: OTHER }], 'moved; blocking oneself dropped');
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM pastes WHERE owner_subject = ?').get(FOLD).n + db.prepare('SELECT COUNT(*) AS n FROM paste_likes WHERE subject_id = ?').get(FOLD).n, 0);

        r = await post(evt());
        assert.deepStrictEqual([r.status, r.json.duplicate], [200, true], 'a redelivery changes nothing');
    } finally {
        srv.close();
    }
    console.log('community subject merge: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
