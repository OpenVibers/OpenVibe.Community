'use strict';
/**
 * Account export and deletion in Community (roadmap WS-B task 7, ADR-033): through the signed pulse consumer,
 * network.account.export_requested sends Community's part to Network (the subject's pastes, comments, threads, posts,
 * likes, votes, reactions, progress, blocks, activity), and network.account.deleted erases what the subject and its
 * merged-in aliases wrote. What someone else answered beneath stays as an authorless "[deleted]" tombstone. Likes,
 * votes and reactions go with the counts recomputed, and progress, blocks and activity go. Community confirms with
 * counts; a failed confirmation is retried without erasing again, and a redelivery sends nothing twice.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { validate } = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const { createPulseConsumer, TOPICS } = require('../server/pulse/consumer');
const { uncovered } = require('openvibe-sdk/account-data');
let SECRET, db, sent, failNext, accountSend, app, DANA, OLD, OTTO, evt;

(async () => {
    SECRET = `whsec_${'ab'.repeat(32)}`;
    db = await testDb();
    {
        const missing = await uncovered(db, {
            taskKeyed: ['spaces', 'comment_threads'],
            exempt: {
                account_data_events: 'the ledger of requests itself: which export and deletion Community applied',
                pulse_quest_people: 'when the Quest badge scan last checked a person: exported as quest_checks.json and erased with them',
                share_members: 'shares are erased by ../identity/account-data.js erase() (subject is jsonb)',
                share_access_requests: 'shares are erased by ../identity/account-data.js erase() (subject is jsonb)',
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);
    }
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
    await db.prepare(`INSERT INTO comment_attachments (media_id, ref_service, ref_type, ref_id, comment_id, owner_subject, filename, mime, size_bytes)
        VALUES ('med_01JAB2C3D4E5F6G7H8J9K0MNP6', 'live', 'vod', '9', 1, ?, 'reply.png', 'image/png', 17)`).run(DANA);
    await db.prepare('INSERT INTO comment_votes (comment_id, subject_id, value) VALUES (2, ?, 1)').run(DANA);
    await db.prepare("INSERT INTO spaces (id, slug, name, created_by) OVERRIDING SYSTEM VALUE VALUES (901, 'dana-space', 'Dana space', ?)").run(DANA);
    await db.prepare("INSERT INTO threads (id, space_id, slug, title, author_subject, score) OVERRIDING SYSTEM VALUE VALUES (1, 901, 't1', 'busy', ?, 0), (2, 901, 't2', 'quiet', ?, 1)").run(DANA, DANA);
    await db.prepare("INSERT INTO posts (id, thread_id, body_markdown, author_subject, is_opening) OVERRIDING SYSTEM VALUE VALUES (1, 1, 'opening', ?, 1), (2, 1, 'otto answers', ?, 0), (3, 2, 'quiet opening', ?, 1)").run(DANA, OTTO, DANA);
    await db.prepare('INSERT INTO thread_votes (thread_id, subject_id, value) VALUES (2, ?, 1)').run(OTTO);
    await db.prepare("INSERT INTO post_reactions (post_id, subject_id, reaction) VALUES (2, ?, 'fire')").run(DANA);
    await db.prepare("INSERT INTO thread_section_reactions (thread_id, section_id, subject_id, value) VALUES (1, 'intro', ?, 1)").run(DANA);
    await db.prepare("INSERT INTO game_progress (subject_id, level, updated_at) VALUES (?, 3, '2026-09-27'), (?, 4, '2026-09-27')").run(DANA, OTTO);
    await db.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, 0), (?, ?, 1, 1, 0)').run(DANA, OTTO, OTTO, DANA);
    // Sharing: DANA owns a paste shared as people, and is a member of OTTO's paste with a pending ask.
    await db.prepare("INSERT INTO shares (service, kind, resource_id, owner_subject, audience) VALUES ('community','paste','p1',?::jsonb,'people'), ('community','paste','p3',?::jsonb,'people')")
        .run(JSON.stringify({ type: 'user', id: DANA }), JSON.stringify({ type: 'user', id: OTTO }));
    await db.prepare("INSERT INTO share_members (service, kind, resource_id, subject, role, added_by, added_at) VALUES ('community','paste','p3',?::jsonb,'viewer',?::jsonb, now())")
        .run(JSON.stringify({ type: 'user', id: DANA }), JSON.stringify({ type: 'user', id: OTTO }));
    await db.prepare("INSERT INTO share_access_requests (id, service, kind, resource_id, subject, requested_at, state) VALUES ('4a5a0b34-96a0-4a69-9c2e-3f7f0a2c5c11','community','paste','p3',?::jsonb, now(), 'pending')")
        .run(JSON.stringify({ type: 'user', id: DANA }));
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
        assert.ok(files['comments.json'] && files['posts.json'] && files['blocks.json'] && files['game_progress.json']);
        assert.strictEqual(files['comment_attachments.json'][0].media_id, 'med_01JAB2C3D4E5F6G7H8J9K0MNP6');
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
        const store = require('../server/pastes/store');
        const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
        assert.deepStrictEqual((await all('SELECT slug_hash FROM retired_paste_slugs ORDER BY slug_hash')).map((r) => r.slug_hash), [sha('p2'), sha('p4')].sort(),
            'the erased pastes\' slugs are retired, as hashes only');
        assert.deepStrictEqual([await store.slugTaken(db, 'p2'), await store.slugTaken(db, 'p4'), await store.slugTaken(db, 'p1'), await store.slugTaken(db, 'p9')], [true, true, true, false],
            'an erased slug is never given out again (AGT-4)');
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, message FROM paste_comments ORDER BY id'), [
            { id: 1, a: OTTO, message: 'nice' }, { id: 2, a: null, message: '[deleted]' }, { id: 3, a: OTTO, message: 'hi dana' }], 'her answered comment a tombstone; the other gone');
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, message, score, reply_count FROM comments ORDER BY id'), [
            { id: 1, a: null, message: '[deleted]', score: 0, reply_count: 1 }, { id: 2, a: OTTO, message: 'reply', score: 0, reply_count: 0 }], 'votes gone and the score recomputed');
        assert.strictEqual((await all('SELECT * FROM comment_attachments')).length, 0, 'comment attachments are removed from a deleted account');
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, title FROM threads ORDER BY id'), [{ id: 1, a: null, title: '[deleted]' }], 'the busy thread a tombstone, the quiet one gone');
        assert.deepStrictEqual(await all('SELECT id, author_subject AS a, body_markdown AS b FROM posts ORDER BY id'), [{ id: 1, a: null, b: '[deleted]' }, { id: 2, a: OTTO, b: 'otto answers' }]);
        assert.strictEqual((await all('SELECT * FROM post_reactions')).length + (await all('SELECT * FROM paste_likes')).length, 0);
        assert.strictEqual((await all('SELECT * FROM thread_section_reactions')).length, 0, 'section reactions go with the person');
        assert.strictEqual((await db.prepare('SELECT likes FROM pastes WHERE id = 3').get()).likes, 0, 'the like count follows');
        assert.deepStrictEqual(await all('SELECT subject_id AS s FROM game_progress'), [{ s: OTTO }]);
        assert.strictEqual((await all('SELECT * FROM network_blocks')).length, 0, 'blocks both ways');
        assert.strictEqual((await db.prepare('SELECT created_by FROM spaces WHERE id = 901').get()).created_by, null, 'the space stays without her');
        assert.deepStrictEqual(await all('SELECT resource_id AS r FROM shares ORDER BY resource_id'), [{ r: 'p3' }], 'her own paste\'s share row went; someone else\'s stays');
        assert.strictEqual((await all('SELECT * FROM share_members')).length, 0, 'her membership is gone');
        assert.strictEqual((await all("SELECT * FROM share_access_requests WHERE state = 'pending'")).length, 0, 'her pending ask is closed');

        r = await post(del);
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'confirmed'], 'the retry confirms without erasing again');
        const conf = sent[1];
        assert.strictEqual(conf.path, '/internal/account-deletions/del_01JAB2C3D4E5F6G7H8J9K0MNP5/confirmations');
        assert.ok(validate('network.account-deletion-confirmation@1', conf.body).valid, JSON.stringify(validate('network.account-deletion-confirmation@1', conf.body).errors));
        assert.deepStrictEqual([conf.body.erased.pastes, conf.body.erased.threads, conf.body.retained.tombstones], [2, 1, 5]);
        r = await post(del);
        assert.strictEqual(r.json.outcome, 'unchanged');
        assert.strictEqual(sent.length, 2);
    } finally {
        srv.close();
        await db.close();
    }
    console.log('community account export and deletion: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
