'use strict';
// community.profile on Network (server/identity/profile-module.js, Contracts 0.41.0, WS-B task 9): the
// person's threads, replies, comments and public pastes (deleted, AI and private ones not counted), first
// and last activity; written with Community's service token through openvibe-sdk/modules only when it
// changed; the scan finds authors whose rows were created, edited or deleted since the previous one.
const assert = require('assert');
const http = require('http');
const { modules } = require('openvibe-contracts');
const { openDb } = require('../server/db');
const { summarize, createProfileModule, ensureSchema } = require('../server/identity/profile-module');

const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';
const BOB = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';
const db = openDb(':memory:');
ensureSchema(db);
const now = Date.parse('2026-09-25T12:00:00Z');
const at = (msAgo) => new Date(now - msAgo).toISOString().replace('T', ' ').slice(0, 19);
const DAY = 86400000;

const space = db.prepare("INSERT INTO spaces (slug, name) VALUES ('profile-test', 'Profile test')").run().lastInsertRowid;
const thread = db.prepare('INSERT INTO threads (space_id, slug, title, author_subject, created_at) VALUES (?, ?, ?, ?, ?)').run(space, 'hello', 'Hello', ANN, at(10 * DAY)).lastInsertRowid;
db.prepare('INSERT INTO posts (thread_id, author_subject, is_opening, body_markdown, created_at) VALUES (?, ?, 1, ?, ?)').run(thread, ANN, 'hi', at(10 * DAY));
db.prepare('INSERT INTO posts (thread_id, author_subject, is_opening, body_markdown, created_at) VALUES (?, ?, 0, ?, ?)').run(thread, ANN, 'reply', at(2 * DAY));
db.prepare('INSERT INTO posts (thread_id, author_subject, is_opening, body_markdown, created_at, deleted_at) VALUES (?, ?, 0, ?, ?, ?)').run(thread, ANN, 'gone', at(DAY), at(DAY));
const ct = db.prepare("INSERT INTO comment_threads (ref_service, ref_type, ref_id) VALUES ('live', 'vod', '1')").run().lastInsertRowid;
db.prepare('INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, ?, ?)').run(ct, ANN, 'nice', at(3 * DAY));
db.prepare("INSERT INTO comments (thread_id, author_subject, origin, message, created_at) VALUES (?, ?, 'ai', ?, ?)").run(ct, ANN, 'bot', at(3 * DAY));
db.prepare("INSERT INTO pastes (slug, owner_subject, content, created_at) VALUES ('p1', ?, 'x', ?)").run(ANN, at(5 * DAY));
db.prepare("INSERT INTO pastes (slug, owner_subject, content, visibility, created_at) VALUES ('p2', ?, 'x', 'private', ?)").run(ANN, at(5 * DAY));

(async () => {
    const s = summarize(db, ANN);
    assert.deepStrictEqual(s, { threads: 1, posts: 1, comments: 1, pastes: 1, first_active_at: new Date(now - 10 * DAY).toISOString(), last_active_at: new Date(now - 2 * DAY).toISOString() });
    assert.ok(modules.validateData('community.profile', s).valid, 'matches the namespace schema');
    assert.strictEqual(summarize(db, BOB), null, 'nothing written: no record');

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

    // The scan: Bob comments, Ann deletes her reply.
    db.prepare('INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, ?, ?)').run(ct, BOB, 'first!', at(60000));
    db.prepare("UPDATE posts SET deleted_at = ? WHERE body_markdown = 'reply'").run(at(30000));
    assert.strictEqual(await mod.scan({ now }), 2);
    assert.deepStrictEqual(puts.slice(1).map((p) => [p.subject, p.data.comments, p.data.posts]).sort(), [[ANN, 1, 0], [BOB, 1, 0]]);
    assert.strictEqual(await mod.scan({ now: now + 5 * 60000 }), 0, 'the next scan starts where this one ended');

    const off = createProfileModule({ db, config: { oauth: {} }, log: {} });
    assert.strictEqual(off.enabled, false); assert.strictEqual(off.start(), false);
    server.close();
    console.log('community.profile: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
