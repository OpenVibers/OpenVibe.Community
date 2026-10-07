'use strict';
/** Account export and deletion retain paste, comment, Pulse, submission and block behavior. */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { validate } = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const { createPulseConsumer, TOPICS } = require('../server/pulse/consumer');
let SECRET, db, sent, failNext, accountSend, app, DANA, OLD, OTTO, evt;

(async () => {
    SECRET = `whsec_${'ab'.repeat(32)}`;
    db = await testDb();
    sent = [];
    failNext = false;
    accountSend = async (p, body) => { if (failNext) { failNext = false; return { ok: false, status: 503 }; } sent.push({ path: p, body }); return { ok: true, status: 200 }; };
    app = express();
    app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], accountSend, log: { error() {}, log() {}, warn() {} } }).router);
    DANA = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP1';
    OLD = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP2';
    OTTO = 'usr_01JAB2C3D4E5F6G7H8J9K0MNP3';
    await db.prepare("INSERT INTO pastes (id, slug, owner_subject, title, content, likes) OVERRIDING SYSTEM VALUE VALUES (1, 'p1', ?, 'mine, answered', 'secret words', 1), (2, 'p2', ?, 'mine, alone', 'more', 0), (3, 'p3', ?, 'otto''s', 'x', 1), (4, 'p4', ?, 'old account', 'y', 0)").run(DANA, DANA, OTTO, OLD);
    await db.prepare("INSERT INTO paste_comments (id, paste_id, author_subject, message, parent_id) OVERRIDING SYSTEM VALUE VALUES (1, 1, ?, 'nice', NULL), (2, 3, ?, 'hi otto', NULL), (3, 3, ?, 'hi dana', 2), (4, 3, ?, 'bye', NULL)").run(OTTO, DANA, OTTO, DANA);
    await db.prepare('INSERT INTO paste_likes (paste_id, subject_id) VALUES (3, ?)').run(DANA);
    await db.prepare("INSERT INTO comment_threads (id, ref_service, ref_type, ref_id) OVERRIDING SYSTEM VALUE VALUES (1, 'live', 'vod', '9')").run();
    await db.prepare("INSERT INTO comments (id, thread_id, parent_id, author_subject, message, score, upvotes, downvotes, reply_count) OVERRIDING SYSTEM VALUE VALUES (1, 1, NULL, ?, 'answered', 0, 0, 0, 1), (2, 1, 1, ?, 'reply', 1, 1, 0, 0), (3, 1, NULL, ?, 'alone', 0, 0, 0, 0)").run(DANA, OTTO, DANA);
    await db.prepare('INSERT INTO comment_votes (comment_id, subject_id, value) VALUES (2, ?, 1)').run(DANA);
    await db.prepare("INSERT INTO game_progress (subject_id, level, updated_at) VALUES (?, 3, '2026-09-27'), (?, 4, '2026-09-27')").run(DANA, OTTO);
    await db.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(DANA, OTTO, OTTO, DANA);
    evt = (id, type, payload) => ({ event_id: id, event_type: type, version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
        subject: { type: 'user', id: payload.subject }, actor: { type: 'user', id: payload.subject }, payload });
    assert.ok(TOPICS.includes('network.account.export_requested') && TOPICS.includes('network.account.deleted'), 'Community subscribes to both');
    const srv = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const post = (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(`http://127.0.0.1:${srv.address().port}/internal/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    };
    try {
        // ── Export ──
        const exp = evt('evt_01JAB2C3D4E5F6G7H8J9K0MN01', 'network.account.export_requested', { export_id: 'exp_01JAB2C3D4E5F6G7H8J9K0MNP4', subject: DANA, requested_at: new Date().toISOString(), deadline: new Date(Date.now() + 1800000).toISOString() });
        let r = await post({ ...exp, source: 'live' });
        assert.strictEqual(r.json.outcome, 'ignored:source');
        r = await post(exp);
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'exported']);
        const part = sent[0].body;
        assert.ok(validate('network.account-export-part@1', part).valid, JSON.stringify(validate('network.account-export-part@1', part).errors));
        const files = Object.fromEntries(part.files.map((f) => [f.name, f.content]));
        assert.deepStrictEqual(files['pastes.json'].map((p) => p.slug).sort(), ['p1', 'p2'], 'her pastes, with their content');
        assert.strictEqual(files['pastes.json'].find((p) => p.slug === 'p1').content, 'secret words');
        assert.ok(files['comments.json'] && files['blocks.json'] && files['game_progress.json']);
        r = await post(exp);
        assert.strictEqual(r.json.outcome, 'unchanged');
        assert.strictEqual(sent.length, 1);

        // ── Deletion ──
        const del = evt('evt_01JAB2C3D4E5F6G7H8J9K0MN02', 'network.account.deleted', { deletion_id: 'del_01JAB2C3D4E5F6G7H8J9K0MNP5', subject: DANA, aliases: [OLD], requested_at: new Date().toISOString(), deleted_at: new Date().toISOString() });
        failNext = true;
        r = await post(del);
        assert.strictEqual(r.status, 500, 'a failed confirmation is redelivered');
        const all = async (sql) => await db.prepare(sql).all();
        assert.deepStrictEqual(await all('SELECT slug, owner_subject AS o, title, content FROM pastes ORDER BY id'), [
            { slug: 'p1', o: null, title: '[deleted]', content: '' }, { slug: 'p3', o: OTTO, title: "otto's", content: 'x' }], "answered paste a tombstone, the alone one gone, the alias's gone");
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, message FROM paste_comments ORDER BY id'), [
            { id: 1, a: OTTO, message: 'nice' }, { id: 2, a: null, message: '[deleted]' }, { id: 3, a: OTTO, message: 'hi dana' }], 'her answered comment a tombstone; the other gone');
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, message, score, reply_count FROM comments ORDER BY id'), [
            { id: 1, a: null, message: '[deleted]', score: 0, reply_count: 1 }, { id: 2, a: OTTO, message: 'reply', score: 0, reply_count: 0 }], 'votes gone and the score recomputed');
        assert.strictEqual((await all('SELECT * FROM paste_likes')).length, 0);
        assert.strictEqual((await db.prepare('SELECT likes FROM pastes WHERE id = 3').get()).likes, 0, 'the like count follows');
        assert.deepStrictEqual(await all('SELECT subject_id AS s FROM game_progress'), [{ s: OTTO }]);
        assert.strictEqual((await all('SELECT * FROM network_blocks')).length, 0, 'blocks both ways');

        r = await post(del);
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'confirmed'], 'the retry confirms without erasing again');
        const conf = sent[1];
        assert.strictEqual(conf.path, '/internal/account-deletions/del_01JAB2C3D4E5F6G7H8J9K0MNP5/confirmations');
        assert.ok(validate('network.account-deletion-confirmation@1', conf.body).valid, JSON.stringify(validate('network.account-deletion-confirmation@1', conf.body).errors));
        assert.deepStrictEqual([conf.body.erased.pastes, conf.body.retained.tombstones], [2, 3]);
        r = await post(del);
        assert.strictEqual(r.json.outcome, 'unchanged');
        assert.strictEqual(sent.length, 2);
    } finally {
        srv.close();
    }
    console.log('community account export and deletion: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
