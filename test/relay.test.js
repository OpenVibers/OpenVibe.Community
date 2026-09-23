'use strict';
/**
 * Discord relay (outbound): off unless DISCORD_RELAY_ENABLED; one delivery per (thread, mapping);
 * the webhook URL comes from the environment variable a mapping names; retries with backoff on
 * 5xx/429/network errors, immediate failure on other 4xx; loop prevention for Discord-origin
 * threads; members/staff spaces never relayed; the staff admin endpoint. A stub webhook server
 * stands in for Discord; the relay's clock is injected so backoff is tested without waiting.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { openDb } = require('../server/db');
const forumStore = require('../server/forum/store');
const { createDiscordRelay } = require('../server/relay/discord');
const { sqlTime } = require('../server/http/v1');

function stubWebhook() {
    const hits = [];
    const plan = []; // queued responses: { status, body, headers }
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            hits.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
            const next = plan.shift() || { status: 204 };
            if (next.hang) return; // never answers
            res.writeHead(next.status, { 'Content-Type': 'application/json', ...(next.headers || {}) });
            res.end(next.body ? JSON.stringify(next.body) : '');
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, hits, plan, close: () => new Promise((r) => server.close(r)),
    })));
}

(async () => {
    const hook = await stubWebhook();
    const db = openDb(':memory:');
    const general = forumStore.getSpace(db, 'general');
    const feedback = forumStore.getSpace(db, 'feedback');
    const env = { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/1/general`, DISCORD_WEBHOOK_FEEDBACK: `${hook.url}/api/webhooks/2/feedback` };
    let clock = Date.parse('2026-09-22T12:00:00Z');
    const now = () => clock;
    const relay = createDiscordRelay({ db, config: { baseUrl: 'https://openvibe.community' }, env, enabled: true, baseMs: 60_000, maxAttempts: 3, now });
    const alex = ids.newId('user');
    require('../server/pastes/store').upsertProjection(db, { subject_id: alex, username: 'alex', display_name: 'Alex @everyone' });
    relay.addMapping({ space_id: general.id, webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' });
    relay.addMapping({ space_id: feedback.id, webhook_url_ref: 'DISCORD_WEBHOOK_FEEDBACK' });
    const newThread = (space, title, extra = {}) => forumStore.createThread(db, { space_id: space.id, title, author_subject: alex, body_markdown: '**Hello** there, [link](https://x.y)', ...extra }).thread;
    const deliveries = () => db.prepare('SELECT * FROM relay_deliveries ORDER BY id').all();
    const settle = () => new Promise((r) => setImmediate(r));

    await check('off by default: nothing is queued or sent', async () => {
        const off = createDiscordRelay({ db, env, now });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(off.enqueueThread(newThread(general, 'Quiet thread'), general), 0);
        assert.deepStrictEqual(await off.drain(), { delivered: 0, retry: 0, failed: 0 });
        assert.strictEqual(deliveries().length, 0);
    });

    await check('a new thread in a mapped space is posted once, with attribution, a link, and no mentions', async () => {
        const th = newThread(general, 'Relay me <please>');
        assert.strictEqual(relay.enqueueThread(th, general), 1);
        assert.strictEqual(relay.enqueueThread(th, general), 0, 'dedupe key per (thread, mapping)');
        await settle();
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1);
        const msg = hook.hits[0];
        assert.strictEqual(msg.path, '/api/webhooks/1/general');
        assert.deepStrictEqual(msg.body.allowed_mentions, { parse: [] });
        assert.match(msg.body.content, /^New thread in \*\*s\/general\*\* by Alex @\u200beveryone: <https:\/\/openvibe\.community\/s\/general\/t\/relay-me-please>$/);
        assert.strictEqual(msg.body.embeds[0].title, 'Relay me <please>');
        assert.strictEqual(msg.body.embeds[0].url, 'https://openvibe.community/s/general/t/relay-me-please');
        assert.strictEqual(msg.body.embeds[0].description, 'Hello there, link');
        assert.strictEqual(msg.body.embeds[0].footer.text, 'OpenVibe.Community · s/general');
        const d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status, d.dedupe_key], ['delivered', 1, 204, `thread:${th.id}:mapping:1`]);
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1, 'a delivered thread is never sent again');
    });

    await check('retries with exponential backoff on 5xx, then delivers', async () => {
        hook.hits.length = 0;
        hook.plan.push({ status: 502, body: { message: 'bad gateway' } });
        const th = newThread(feedback, 'Flaky Discord');
        relay.enqueueThread(th, feedback);
        await settle(); await relay.drain();
        let d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status], ['pending', 1, 502]);
        assert.match(d.last_error, /Discord answered 502: bad gateway/);
        assert.strictEqual(d.next_attempt_at, '2026-09-22 12:01:00', 'first retry after baseMs');
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1, 'not due yet');
        clock += 60_000;
        hook.plan.push({ status: 500 });
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.next_attempt_at], ['pending', 2, '2026-09-22 12:03:00'], 'second retry after 2 × baseMs');
        clock += 120_000;
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_error], ['delivered', 3, null]);
        assert.strictEqual(hook.hits.length, 3);
    });

    await check('429 honours retry_after; exhausted attempts end as failed; other 4xx fail at once', async () => {
        const th = newThread(general, 'Rate limited');
        hook.plan.push({ status: 429, body: { message: 'You are being rate limited.', retry_after: 300 } });
        relay.enqueueThread(th, general);
        await settle(); await relay.drain();
        let d = deliveries().find((x) => x.thread_id === th.id);
        assert.strictEqual(d.status, 'pending');
        assert.strictEqual(Date.parse(`${d.next_attempt_at.replace(' ', 'T')}Z`) - clock, 300_000);
        clock += 300_000;
        hook.plan.push({ status: 503 }, { status: 503 });
        await relay.drain();
        clock += 10 * 60_000;
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status], ['failed', 3, 503]);

        const gone = newThread(general, 'Webhook deleted');
        hook.plan.push({ status: 404, body: { message: 'Unknown Webhook' } });
        relay.enqueueThread(gone, general);
        await settle(); await relay.drain();
        d = deliveries().find((x) => x.thread_id === gone.id);
        assert.deepStrictEqual([d.status, d.attempts], ['failed', 1]);
        assert.match(d.last_error, /404: Unknown Webhook/);
    });

    await check('a missing webhook variable and network errors are retried, then it delivers; the URL never enters the DB', async () => {
        const showcase = forumStore.getSpace(db, 'showcase');
        relay.addMapping({ space_id: showcase.id, webhook_url_ref: 'DISCORD_WEBHOOK_SHOWCASE' });
        const th = newThread(showcase, 'Env later');
        relay.enqueueThread(th, showcase);
        await settle(); await relay.drain();
        let d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.last_error], ['pending', 'webhook URL variable DISCORD_WEBHOOK_SHOWCASE is not set']);
        env.DISCORD_WEBHOOK_SHOWCASE = 'http://127.0.0.1:1/api/webhooks/refused';
        clock += 60_000;
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status], ['pending', 2, null], 'a network error is retried');
        assert.ok(d.last_error);
        env.DISCORD_WEBHOOK_SHOWCASE = `${hook.url}/api/webhooks/3/showcase`;
        clock += 120_000;
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.strictEqual(d.status, 'delivered');
        const everything = JSON.stringify(db.prepare('SELECT * FROM relay_mappings').all()) + JSON.stringify(deliveries());
        assert.ok(!everything.includes('/api/webhooks/'), 'no webhook URL stored anywhere');
    });

    await check('loop prevention: Discord-origin threads are never relayed; members/staff spaces never leave the site', async () => {
        const before = hook.hits.length;
        const fromDiscord = newThread(general, 'Came from Discord', { origin: 'discord' });
        assert.strictEqual(relay.enqueueThread(fromDiscord, general), 0);
        // Even a delivery row that got queued somehow is refused at send time.
        db.prepare('INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, next_attempt_at) VALUES (?, 1, ?, ?)').run(fromDiscord.id, `thread:${fromDiscord.id}:mapping:1`, sqlTime(clock));
        await relay.drain();
        const d = deliveries().find((x) => x.thread_id === fromDiscord.id);
        assert.deepStrictEqual([d.status, d.last_error], ['failed', 'loop prevention: thread came from Discord']);
        db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members')").run();
        const ins = forumStore.getSpace(db, 'insiders');
        relay.addMapping({ space_id: ins.id, webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' });
        assert.strictEqual(relay.enqueueThread(newThread(ins, 'Members only'), ins), 0);
        assert.strictEqual(hook.hits.length, before);
    });

    await check('disabled mappings queue nothing; retry() puts a failed delivery back with a fresh budget', async () => {
        relay.setMappingEnabled(1, false);
        assert.strictEqual(relay.enqueueThread(newThread(general, 'Mapping off'), general), 0);
        relay.setMappingEnabled(1, true);
        const failed = deliveries().find((x) => x.status === 'failed' && x.last_status === 404);
        assert.strictEqual(relay.retry(failed.id), 1);
        await settle(); await relay.drain();
        assert.strictEqual(deliveries().find((x) => x.id === failed.id).status, 'delivered');
        assert.strictEqual(relay.retry(failed.id), 0, 'delivered ones stay delivered');
    });

    await check('app wiring: a thread created through the API is relayed; the admin endpoint is staff-only and URL-free', async () => {
        const t = await boot({
            authority: 'community',
            appOpts: { relayOptions: { enabled: true, env: { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/9/app` } }, forumLimits: { threads: { cooldownSec: 0 } } },
        });
        const net = t.network;
        const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
        const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', role: 'user' });
        const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
        const call = (path, { method = 'GET', cookie, token, json, headers = {} } = {}) => {
            const h = { ...headers };
            if (token) h.authorization = `Bearer ${token}`;
            if (json !== undefined) h['content-type'] = 'application/json';
            return t.get(path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
        };
        assert.strictEqual((await call('/api/v1/relay/mappings', { method: 'POST', cookie: samJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } })).status, 403);
        const bad = await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'https://discord.com/api/webhooks/secret' } });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.json().code, 'relay.invalid_ref');
        const m = await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } });
        assert.strictEqual(m.status, 201, m.text);
        assert.deepStrictEqual([m.json().mapping.space, m.json().mapping.webhook_configured, m.json().mapping.enabled], ['general', true, true]);
        const before = hook.hits.length;
        const th = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Through the app', body: 'hi' } });
        assert.strictEqual(th.status, 201);
        for (let i = 0; i < 50 && hook.hits.length === before; i++) await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(hook.hits.length, before + 1);
        assert.strictEqual(hook.hits[hook.hits.length - 1].path, '/api/webhooks/9/app');
        hook.plan.push({ status: 400, body: { message: 'Invalid Form Body' } });
        await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'This one fails', body: 'hi' } });
        for (let i = 0; i < 50 && hook.hits.length === before + 1; i++) await new Promise((r) => setTimeout(r, 10));
        await t.app.locals.relay.drain();
        assert.strictEqual((await call('/api/v1/relay/deliveries')).status, 401);
        assert.strictEqual((await call('/api/v1/relay/deliveries', { cookie: samJwt })).status, 403);
        const failed = await call('/api/v1/relay/deliveries?status=failed', { cookie: adminJwt });
        assert.strictEqual(failed.status, 200, failed.text);
        assert.strictEqual(failed.json().enabled, true);
        assert.strictEqual(failed.json().deliveries.length, 1);
        assert.match(failed.json().deliveries[0].last_error, /400: Invalid Form Body/);
        assert.strictEqual(failed.json().deliveries[0].thread.url, '/s/general/t/this-one-fails');
        const svcAdmin = await call('/api/v1/relay/deliveries', { token: net.signService({ cap: ['community.comment.moderate'] }) });
        assert.strictEqual(svcAdmin.status, 200);
        assert.ok(!(failed.text + svcAdmin.text + (await call('/api/v1/relay/mappings', { cookie: adminJwt })).text).includes('/api/webhooks/'), 'responses never carry a webhook URL');
        await t.close();
    });

    await check('staff can map only allow-listed webhook variables, never the URL in some other env var', async () => {
        const secretHits = [];
        const internal = { url: 'http://127.0.0.1:9/internal', hits: secretHits };
        const env = { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/1/ok`, OV_MEDIA_INTERNAL_URL: internal.url, NETWORK_INTERNAL_URL: internal.url, DISCORD_WEBHOOKS_X: internal.url };
        const fetchSpy = (url, o) => { if (String(url).startsWith(internal.url)) secretHits.push(url); return fetch(url, o); };
        const t = await boot({ authority: 'community', appOpts: { relayOptions: { enabled: true, env, fetchImpl: fetchSpy }, forumLimits: { threads: { cooldownSec: 0 } } } });
        const net = t.network;
        const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
        const samJwt = net.sign({ id: 9, subject_id: net.addUser({ network_user_id: 9, username: 'sam' }).subject_id, username: 'sam', role: 'user' });
        const call = (path, { method = 'GET', cookie, token, json } = {}) => t.get(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
        const map = (ref, who = { cookie: adminJwt }) => call('/api/v1/relay/mappings', { method: 'POST', json: { space: 'general', webhook_url_ref: ref }, ...who });
        for (const ref of ['OV_MEDIA_INTERNAL_URL', 'NETWORK_INTERNAL_URL', 'DISCORD_WEBHOOKS_X', 'PATH', 'DISCORD_WEBHOOK_']) {
            const r = await map(ref);
            assert.strictEqual(r.status, 400, `${ref}: ${r.text}`);
            assert.strictEqual(r.json().code, 'relay.ref_not_allowed');
            const svc = await map(ref, { token: net.signService({ cap: ['community.comment.moderate'] }) });
            assert.strictEqual(svc.status, 400, `${ref} as a service`);
        }
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM relay_mappings').get().n, 0);
        assert.throws(() => t.app.locals.relay.addMapping({ space_id: 1, webhook_url_ref: 'OV_MEDIA_INTERNAL_URL' }), /not an allowed webhook variable/);
        // A mapping that predates the allow-list (straight into the table) is never sent to, and
        // does not reveal whether that variable is set.
        const general = t.db.prepare("SELECT id FROM spaces WHERE slug = 'general'").get();
        t.db.prepare("INSERT INTO relay_mappings (space_id, direction, webhook_url_ref, enabled) VALUES (?, 'out', 'OV_MEDIA_INTERNAL_URL', 1)").run(general.id);
        const listed = (await call('/api/v1/relay/mappings', { cookie: adminJwt })).json().mappings.find((m) => m.webhook_url_ref === 'OV_MEDIA_INTERNAL_URL');
        assert.strictEqual(listed.webhook_configured, false);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Would go inside', body: 'hi' } })).status, 201);
        await t.app.locals.relay.drain();
        assert.deepStrictEqual(secretHits, [], 'nothing was sent to the internal URL');
        const d = t.db.prepare("SELECT d.status, d.last_error FROM relay_deliveries d JOIN relay_mappings m ON m.id = d.mapping_id WHERE m.webhook_url_ref = 'OV_MEDIA_INTERNAL_URL'").get();
        assert.strictEqual(d.status, 'failed');
        assert.match(d.last_error, /not an allowed webhook variable/);
        assert.strictEqual((await map('DISCORD_WEBHOOK_GENERAL')).status, 201, 'the conventional names still work');
        await t.close();
        // DISCORD_RELAY_WEBHOOK_VARS narrows it to exact names.
        const { createDiscordRelay } = require('../server/relay/discord');
        const strict = createDiscordRelay({ db: t.db, env, webhookVars: ['DISCORD_WEBHOOK_GENERAL'] });
        assert.strictEqual(strict.refAllowed('DISCORD_WEBHOOK_GENERAL'), true);
        assert.strictEqual(strict.refAllowed('DISCORD_WEBHOOK_OTHER'), false);
        assert.strictEqual(createDiscordRelay({ db: t.db, env }).refAllowed('DISCORD_WEBHOOK_OTHER'), true);
    });

    await hook.close();
    done();
})();
