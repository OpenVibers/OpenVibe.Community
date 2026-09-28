'use strict';
/**
 * Per-actor rate limits (server/actor-limits.js, roadmap WS-R task 4): past its limit one caller gets
 * 429 problem+json `rate_limited` with Retry-After, before the route does any work, while another
 * caller still passes; the window reopens on the clock. A person is counted as themselves whether they
 * call directly or a service names them; a service relaying a signed-out visitor is counted by the
 * visitor's forwarded address; a service reading for itself is not counted; writes have their own,
 * tighter numbers. Health, ready, release.json, metrics and the Events deliveries are never limited.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { actor, serviceItself } = require('../server/actor-limits');

(async () => {
    // 15 s into a minute, so the minute window has 45 s left. Reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const t = await boot({
        authority: 'community',
        appOpts: {
            actorLimits: { limits: { minute: 3, hour: 100 }, now: () => clock },
            // The per-person content limits out of the way, so the per-actor one is what answers.
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000, duplicate: false } },
        },
    });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const live = net.signService({ cap: ['community.comment.write', 'community.pulse.write'] });

    const call = (path, { method = 'GET', token, cookie, headers = {}, json } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const PULSE = '/api/v1/pulse';

    await check('a read: 3 a minute per person, then 429 rate_limited with Retry-After; another person passes', async () => {
        for (let i = 0; i < 3; i++) assert.strictEqual((await call(PULSE, { cookie: alexJwt })).status, 200);
        const r = await call(PULSE, { cookie: alexJwt });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.headers.get('retry-after'), '45');
        assert.ok(/^application\/problem\+json/.test(r.headers.get('content-type')));
        const body = r.json();
        assert.deepStrictEqual([body.code, body.status, body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(body.detail.includes('community.pulse.read'), body.detail);
        assert.strictEqual((await call(PULSE, { cookie: samJwt })).status, 200, 'another person still passes');
    });

    await check('a service naming the person counts against that person', async () => {
        const r = await call(PULSE, { token: live, headers: { 'X-OV-Subject': alex.subject_id } });
        assert.deepStrictEqual([r.status, r.json().code], [429, 'rate_limited']);
    });

    await check('a service relaying signed-out visitors: each forwarded address on its own; reading for itself: not counted', async () => {
        const visitor = (ip) => call(PULSE, { token: live, headers: { 'X-Forwarded-For': ip } });
        for (let i = 0; i < 3; i++) assert.strictEqual((await visitor('203.0.113.7')).status, 200);
        assert.strictEqual((await visitor('203.0.113.7')).status, 429);
        assert.strictEqual((await visitor('203.0.113.8')).status, 200, 'another visitor still passes');
        for (let i = 0; i < 6; i++) assert.strictEqual((await call(PULSE, { token: live })).status, 200);
    });

    await check('the next minute opens the window again', async () => {
        clock += 45 * 1000;
        assert.strictEqual((await call(PULSE, { cookie: alexJwt })).status, 200);
    });

    await check('a write has its own number: 20 comments a minute, the 21st refused before it is stored', async () => {
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        const res = await call('/api/v1/comments/threads/resolve', { method: 'POST', cookie: alexJwt, json: { ref: { service: 'live', type: 'stream', id: '42' } } });
        assert.strictEqual(res.status, 201, res.text);
        const thread = res.json().thread;
        const post = (i) => call(`/api/v1/comments/threads/${thread.access_id || thread.id}/comments`, { method: 'POST', cookie: alexJwt, json: { message: `hello ${i}` } });
        for (let i = 0; i < 20; i++) {
            const r = await post(i);
            assert.strictEqual(r.status, 201, `comment ${i + 1}: ${r.text}`);
        }
        const r = await post(20);
        assert.deepStrictEqual([r.status, r.json().code, r.headers.get('retry-after')], [429, 'rate_limited', '60']);
        const stored = t.db.prepare("SELECT COUNT(*) AS n FROM comments c JOIN comment_threads th ON th.id = c.thread_id WHERE th.ref_service = 'live' AND th.ref_type = 'stream' AND th.ref_id = '42'").get().n;
        assert.strictEqual(stored, 20, 'nothing stored');
        assert.strictEqual((await call(`/api/v1/comments/threads/${thread.access_id || thread.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi' } })).status, 201, 'another person still comments');
    });

    await check('health, ready, release.json, metrics and the Events deliveries are never limited', async () => {
        for (let i = 0; i < 6; i++) {
            assert.strictEqual((await call('/api/health')).status, 200);
            assert.notStrictEqual((await call('/api/ready')).status, 429);
            assert.strictEqual((await call('/release.json')).status, 200);
            assert.strictEqual((await call('/metrics')).status, 200);
            assert.notStrictEqual((await call('/internal/events', { method: 'POST', json: {} })).status, 429);
        }
    });

    await check('refusals are counted in community_rate_limited_total', async () => {
        const m = (await call('/metrics')).text;
        assert.ok(/community_rate_limited_total\{limit="community.pulse.read",window="minute"\} 3/.test(m), m.split('\n').filter((l) => l.includes('rate_limited')).join('\n'));
        assert.ok(/community_rate_limited_total\{limit="community.comment.create",window="minute"\} 1/.test(m));
    });

    await check('who is counted', () => {
        const req = (viewer, { xff = null, ip = '127.0.0.1' } = {}) => ({ viewer, ip, get: (h) => (h === 'x-forwarded-for' ? xff : undefined) });
        assert.strictEqual(actor(req({ kind: 'user', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(req({ kind: 'service', service: 'svc:live', subject: 'usr_a' })), 'user:usr_a');
        assert.strictEqual(actor(req({ kind: 'service', service: 'svc:live', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'ip:203.0.113.9');
        assert.strictEqual(actor(req({ kind: 'service', service: 'svc:live', subject: null })), 'svc:live', 'acting as itself (AI output, moderation)');
        assert.strictEqual(actor(req({ kind: 'service', service: 'app:app_1', subject: null }, { xff: '203.0.113.9', ip: '203.0.113.9' })), 'app:app_1', 'an app never relays by address');
        assert.strictEqual(actor(req({ kind: 'anonymous', subject: null }, { ip: '198.51.100.4' })), 'ip:198.51.100.4');
        assert.strictEqual(serviceItself(req({ kind: 'service', service: 'svc:live', subject: null })), true);
        assert.strictEqual(serviceItself(req({ kind: 'service', service: 'app:app_1', subject: null })), false);
    });

    await t.close();
    done();
})();
