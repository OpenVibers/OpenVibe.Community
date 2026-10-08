'use strict';
// community.profile on Network (server/identity/profile-module.js, Contracts 0.41.0, WS-B task 9): the
// person's comments and public pastes, updated only when changed; the scan finds authors whose rows were created, edited or deleted since the previous one.
const assert = require('assert');
const http = require('http');
const { modules } = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const { summarize, createProfileModule } = require('../server/identity/profile-module');

let ANN, BOB, db, now, at, DAY, ct;

(async () => {
    ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
    BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
    db = await testDb();
    now = Date.parse('2026-09-25T12:00:00Z');
    at = (msAgo) => new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19);
    DAY = 86400000;
    ct = (await db.prepare("INSERT INTO comment_threads (ref_service, ref_type, ref_id) VALUES ('live', 'vod', '1') RETURNING id").run()).lastInsertRowid;
    await db.prepare('INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, ?, ?)').run(ct, ANN, 'nice', at(3 * DAY));
    await db.prepare("INSERT INTO comments (thread_id, author_subject, origin, message, created_at) VALUES (?, ?, 'ai', ?, ?)").run(ct, ANN, 'bot', at(3 * DAY));
    await db.prepare("INSERT INTO pastes (slug, owner_subject, content, created_at) VALUES ('p1', ?, 'x', ?)").run(ANN, at(5 * DAY));
    await db.prepare("INSERT INTO pastes (slug, owner_subject, content, visibility, created_at) VALUES ('p2', ?, 'x', 'private', ?)").run(ANN, at(5 * DAY));
    const s = await summarize(db, ANN);
    assert.deepStrictEqual(s, { threads: 0, posts: 0, comments: 1, pastes: 1, first_active_at: new Date(now - 5 * DAY).toISOString(), last_active_at: new Date(now - 3 * DAY).toISOString() });
    assert.ok(modules.validateData('community.profile', s).valid, 'matches the namespace schema');
    assert.strictEqual(await summarize(db, BOB), null, 'nothing written: no record');

    const puts = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            if (req.url === '/oauth/token') return res.end(JSON.stringify({ access_token: 'svc', token_type: 'Bearer', expires_in: 300 }));
            const m = req.url.match(/^\/internal\/modules\/community\.profile\/(usr_[0-9A-Z]+)$/);
            assert.ok(m && req.method === 'PUT' && req.headers.authorization === 'Bearer svc', `${req.method} ${req.url}`);
            puts.push({ subject: m[1], data: JSON.parse(body).data });
            res.statusCode = 201; res.end(JSON.stringify({ revision: puts.length }));
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const config = { networkInternalUrl: `http://127.0.0.1:${server.address().port}`, oauth: { clientId: 'community', clientSecret: 'x'.repeat(40) } };
    const mod = createProfileModule({ db, config, log: {} });
    assert.ok(await mod.push(ANN));
    assert.deepStrictEqual(puts[0], { subject: ANN, data: s });
    assert.strictEqual(await mod.push(ANN), false, 'unchanged: not written again');
    assert.strictEqual(await mod.push('gst_01JAB2C3D4E5F6G7H8J9K0MNPG'), false, 'guests have no record');

    // The scan: Bob comments.
    await db.prepare('INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, ?, ?)').run(ct, BOB, 'first!', at(60000));
    assert.strictEqual(await mod.scan({ now }), 1);
    assert.deepStrictEqual(puts.slice(1).map((p) => [p.subject, p.data.comments, p.data.posts]).sort(), [[BOB, 1, 0]]);
    assert.strictEqual(await mod.scan({ now: now + 5 * 60000 }), 0, 'the next scan starts where this one ended');

    const off = createProfileModule({ db, config: { oauth: {} }, log: {} });
    assert.strictEqual(off.enabled, false); assert.strictEqual(off.start(), false);
    server.close();
    await db.close();
    console.log('community.profile: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
