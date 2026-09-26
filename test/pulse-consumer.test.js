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
const vipDrops = [];
app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], vipCache: { handleEvent: (e) => { vipDrops.push(e.event_id); return true; } }, log: { error() {}, log() {}, warn() {} } }).router);
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
    // VIP convergence: a membership change from VIP drops cached members-only answers once; from anyone else, nothing.
    const vipEv = (source) => evt({ event_type: 'vip.membership.changed', source, subject: { type: 'membership', id: 'mbr_1', revision: 2 }, actor: { type: 'service', id: 'vip' },
        payload: { member: { type: 'user', id: USR }, creator: { type: 'user', id: USR }, status: 'canceled' } });
    const v1 = vipEv('vip');
    r = await post(v1);
    assert.strictEqual(r.json.outcome, 'vip:invalidated');
    r = await post(v1);
    assert.strictEqual(r.json.duplicate, true, 'a redelivery drops nothing twice');
    r = await post(vipEv('live'));
    assert.strictEqual(r.json.outcome, 'ignored:source');
    assert.deepStrictEqual(vipDrops, [v1.event_id]);
    assert.strictEqual(items().length, 2, 'no Pulse item for a membership');
    // Game progress (WS-M task 2): games.progress.summary writes through network.module.updated.
    const USR2 = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
    const mod = (level, over = {}) => evt({ event_type: 'network.module.updated', source: 'network', visibility: 'internal', subject: { type: 'user', id: USR2 }, actor: { type: 'service', id: 'games' },
        payload: { owner: { type: 'user', id: USR2 }, namespace: 'games.progress.summary', namespace_owner: 'games', schema_version: 1, revision: 1, change: 'updated', reason: 'write', keys: ['level'], public: { level, achievements: 3, playtime_hours: 2 } }, ...over });
    r = await post(mod(7));
    assert.strictEqual(r.json.outcome, 'games:baseline', 'the first record seen is a baseline, not a stale announcement');
    r = await post(mod(9));
    assert.strictEqual(r.json.outcome, 'games:no_milestone');
    const m11 = mod(11);
    r = await post(m11);
    assert.strictEqual(r.json.outcome, 'pulse:created');
    assert.deepStrictEqual(items()[2], { source_service: 'games', source_type: 'level', source_id: `${USR2}:10`, title: 'Reached level 10 in Scraplandia', url: 'https://openvibe.games/', actor_subject: USR2, origin: 'user' });
    assert.strictEqual((await post(m11)).json.duplicate, true);
    r = await post(mod(6));
    assert.strictEqual(r.json.outcome, 'games:no_milestone', 'a level going down (another character) announces nothing');
    r = await post(mod(12));
    assert.strictEqual(r.json.outcome, 'games:no_milestone', 'the stored level never went down, so 10 is not crossed again');
    r = await post(mod(15));
    assert.strictEqual(items()[3].title, 'Reached level 15 in Scraplandia');
    assert.strictEqual((await post(mod(20, { payload: { owner: { type: 'user', id: USR2 }, namespace: 'ai.usage_summary', change: 'updated', public: { level: 20 } } }))).json.outcome, 'ignored:namespace');
    assert.strictEqual((await post(mod(20, { source: 'games' }))).json.outcome, 'ignored:source', 'only Network speaks for user modules');
    assert.strictEqual((await post(mod(20, { payload: { owner: { type: 'user', id: USR2 }, namespace: 'games.progress.summary', change: 'delete' } }))).json.outcome, 'ignored:change');
    assert.strictEqual((await post(mod(20, { payload: { owner: { type: 'user', id: USR2 }, namespace: 'games.progress.summary', change: 'updated', keys: ['level'] } }))).json.outcome, 'ignored:payload', 'no public level, nothing read');
    assert.strictEqual(items().length, 4);
    srv.close();
    console.log('pulse consumer: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
