'use strict';
/** Network subject merges keep pastes, comments, Pulse, game progress and blocks consistent. */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { testDb } = require('./helpers/db');
const { createPulseConsumer, TOPICS } = require('../server/pulse/consumer');
let SECRET, db, app, KEEP, FOLD, OTHER, MERGE, evt;

// What the folded-in account left in Community.

   // paste 1: both liked

(async () => {
    SECRET = `whsec_${'ef'.repeat(32)}`;
    db = await testDb();
    app = express();
    app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], log: { error() {}, log() {}, warn() {} } }).router);
    KEEP = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
    FOLD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2';
    OTHER = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
    MERGE = 'mrg_01JAB2C3D4E5F6G7H8J9K0MNP4';
    evt = (over = {}) => ({ event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN09', event_type: 'network.subject.merged', version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
        subject: { type: 'user', id: KEEP }, actor: { type: 'user', id: KEEP },
        payload: { merge_id: MERGE, from: FOLD, into: KEEP, merged_at: new Date().toISOString(), initiated_by: 'person' }, ...over });
    await db.prepare("INSERT INTO pastes (id, slug, owner_subject, likes) OVERRIDING SYSTEM VALUE VALUES (1, 'p1', ?, 2), (2, 'p2', ?, 1)").run(FOLD, OTHER);
    await db.prepare('INSERT INTO paste_likes (paste_id, subject_id) VALUES (1, ?), (1, ?), (2, ?)').run(FOLD, KEEP, FOLD);
    await db.prepare("INSERT INTO comment_threads (id, ref_service, ref_type, ref_id) OVERRIDING SYSTEM VALUE VALUES (1, 'live', 'vod', '9')").run();
    await db.prepare("INSERT INTO comments (id, thread_id, message, author_subject, score, upvotes, downvotes) OVERRIDING SYSTEM VALUE VALUES (1, 1, 'hi', ?, 2, 2, 0)").run(OTHER);
    await db.prepare('INSERT INTO comment_votes (comment_id, subject_id, value) VALUES (1, ?, 1), (1, ?, 1)').run(FOLD, KEEP);
    await db.prepare("INSERT INTO game_progress (subject_id, level, updated_at) VALUES (?, 3, '2026-09-27'), (?, 5, '2026-09-27')").run(FOLD, KEEP);
    await db.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(FOLD, OTHER, FOLD, KEEP);
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
        const owner = async (sql, ...a) => await db.prepare(sql).get(...a);
        assert.strictEqual((await owner('SELECT owner_subject AS s FROM pastes WHERE id = 1')).s, KEEP);
        // Likes: paste 1 had both (one dropped, count 1); paste 2's like moved.
        assert.deepStrictEqual((await db.prepare('SELECT paste_id AS p, subject_id AS s FROM paste_likes ORDER BY p').all()).map((x) => [x.p, x.s]), [[1, KEEP], [2, KEEP]]);
        assert.strictEqual((await owner('SELECT likes FROM pastes WHERE id = 1')).likes, 1, 'the cached count follows the rows');
        // Votes: comment 1 had both (score recomputed to 1).
        assert.deepStrictEqual(await owner('SELECT score, upvotes, downvotes FROM comments WHERE id = 1'), { score: 1, upvotes: 1, downvotes: 0 });
        assert.deepStrictEqual(await db.prepare('SELECT subject_id AS s, level FROM game_progress').all(), [{ s: KEEP, level: 5 }]);
        assert.deepStrictEqual(await db.prepare('SELECT blocker_subject AS a, blocked_subject AS b FROM network_blocks').all(), [{ a: KEEP, b: OTHER }], 'moved; blocking oneself dropped');
        assert.strictEqual((await db.prepare('SELECT COUNT(*) AS n FROM pastes WHERE owner_subject = ?').get(FOLD)).n + (await db.prepare('SELECT COUNT(*) AS n FROM paste_likes WHERE subject_id = ?').get(FOLD)).n, 0);

        r = await post(evt());
        assert.deepStrictEqual([r.status, r.json.duplicate], [200, true], 'a redelivery changes nothing');
    } finally {
        srv.close();
        await db.close();
    }
    console.log('community subject merge: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
