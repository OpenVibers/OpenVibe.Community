'use strict';
/** Pulse's Events consumer: signed deliveries become Pulse items once; forged, proxied or non-public ones never do. */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { openDb } = require('../server/db');
const { createPulseConsumer } = require('../server/pulse/consumer');

const SECRET = `whsec_${'ab'.repeat(32)}`;
const db = openDb(':memory:');
const app = express();
app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], log: { error() {}, log() {}, warn() {} } }).router);
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
let seq = 0;
const evt = (over) => ({ event_id: `evt_01JAB2C3D4E5F6G7H8J9K0M${String(++seq).padStart(3, '0')}`.slice(0, 30), event_type: 'live.stream.started', version: 1, source: 'live', visibility: 'public', timestamp: new Date().toISOString(),
    subject: { type: 'stream', id: '2477', revision: 1 }, actor: { type: 'user', id: USR },
    payload: { stream_id: 2477, channel: { username: 'goosely', display_name: 'Goosely', url: 'https://openvibe.live/@goosely', subject: { type: 'user', id: USR } }, title: 'Night walk', started_at: new Date().toISOString() }, ...over });

(async () => {
    const srv = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const post = (event, { secret = SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(`http://127.0.0.1:${srv.address().port}/internal/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } })
            .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
    };
    const items = () => db.prepare('SELECT source_service, source_type, source_id, title, url, actor_subject, origin FROM pulse_items ORDER BY id').all();

    const e1 = evt();
    let r = await post(e1);
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.outcome, 'pulse:created');
    assert.deepStrictEqual(items(), [{ source_service: 'live', source_type: 'stream', source_id: '2477', title: 'Goosely went live: Night walk', url: 'https://openvibe.live/@goosely', actor_subject: USR, origin: 'user' }]);
    r = await post(e1);
    assert.strictEqual(r.json.duplicate, true, 'a redelivery does nothing');
    assert.strictEqual(items().length, 1);

    assert.strictEqual((await post(evt(), { secret: `whsec_${'cd'.repeat(32)}` })).status, 401, 'forged signature');
    assert.strictEqual((await post(evt(), { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 403, 'came through the proxy');
    r = await post(evt({ visibility: 'internal', subject: { type: 'stream', id: '9', revision: 1 } }));
    assert.strictEqual(r.json.outcome, 'ignored:not_public');
    r = await post(evt({ event_type: 'blog.post.published', source: 'blog', subject: { type: 'post', id: 'pst_1' }, actor: { type: 'service', id: 'blog' },
        payload: { blog: 'openvibe', canonical_url: 'https://openvibe.blog/@openvibe/hello', publication_state: 'published', visibility: 'public', indexability: { decision: 'index', reasons: [] } } }));
    assert.strictEqual(r.json.outcome, 'pulse:created');
    assert.strictEqual(items()[1].title, 'New post on the openvibe blog');
    assert.strictEqual(items()[1].origin, 'system', 'no person when a service published it');
    r = await post(evt({ event_type: 'wiki.page.published', source: 'wiki', subject: { type: 'page', id: 'pg_2' },
        payload: { canonical_url: 'https://openvibe.wiki/w/help/start', publication_state: 'published', visibility: 'public', space: 'help', slug: 'start', indexability: { decision: 'noindex', reasons: ['thin'] } } }));
    assert.strictEqual(r.json.outcome, 'ignored:not_public', 'a noindex page stays out of Pulse');
    assert.strictEqual(items().length, 2);
    srv.close();
    console.log('pulse consumer: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
