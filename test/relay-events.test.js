'use strict';
/**
 * The Discord relay as an Events worker (relay/events-worker.js): creates come from Community's own
 * community.thread.created / community.post.created read back from OpenVibe.Events' pull API with a
 * stored cursor. First start begins at the head (history is never announced); new events queue
 * deliveries (source 'events', the event id) that are sent once; a replay queues nothing twice; the
 * cursor survives a restart; members-only, Discord-origin, redacted and foreign events are ignored;
 * Events being down or a retention gap shows in the status; while the worker runs the forum's own
 * calls queue no creates. Last, the whole path in the app: an API write → Community's outbox → a fake
 * Events → the worker → a fake Discord webhook.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { createClient } = require('openvibe-sdk/core');
const { createEventsClient } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/app');
const { startWebhooks } = require('./helpers/fake-discord');
const { startEvents } = require('./helpers/fake-events');
const { openDb } = require('../server/db');
const forumStore = require('../server/forum/store');
const { createDiscordRelay } = require('../server/relay/discord');
const { createRelayEventsWorker, CURSOR } = require('../server/relay/events-worker');

let evn = 0;
function envelope(type, payload, extra = {}) {
    evn++;
    return { event_id: `evt_TEST${String(evn).padStart(22, '0')}`, event_type: type, source: 'community', version: 1, timestamp: new Date().toISOString(), payload, ...extra };
}
const threadEvent = (t, visibility = 'public') => envelope('community.thread.created', { thread_id: t.id, space: 'general', visibility, author: null, url: null });
const postEvent = (p, t, visibility = 'public') => envelope('community.post.created', { post_id: p.id, thread_id: t.id, space: 'general', visibility, author: null, url: null });

(async () => {
    const hook = await startWebhooks();
    const events = await startEvents();
    const db = openDb(':memory:');
    const general = forumStore.getSpace(db, 'general');
    const env = { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/1/general` };
    const relay = createDiscordRelay({ db, config: { baseUrl: 'https://openvibe.community' }, env, enabled: true, baseMs: 1000, maxAttempts: 3 });
    relay.addMapping({ space_id: general.id, webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' });
    const client = createEventsClient(createClient({ baseUrls: { events: events.url }, getToken: async () => 'test-token', retries: 0 }), { source: 'community' });
    const worker = createRelayEventsWorker({ db, relay, events: client, pollMs: 3_600_000, pageLimit: 2 });
    relay.attach({ worker });
    const alex = ids.newId('user');
    const newThread = (title, extra = {}) => forumStore.createThread(db, { space_id: general.id, title, author_subject: alex, body_markdown: `${title} body`, ...extra }).thread;
    const deliveries = () => db.prepare('SELECT * FROM relay_deliveries ORDER BY id').all();
    const settle = () => new Promise((r) => setImmediate(r));

    await check('off without Events or the client secret, or with DISCORD_RELAY_EVENTS=off; the forum queues creates then', async () => {
        const a = createRelayEventsWorker({ db, relay, eventsUrl: null, clientSecret: 'x', tokenUrl: 'http://127.0.0.1:9/oauth/token' });
        assert.deepStrictEqual([a.enabled, a.status().reason], [false, 'EVENTS_URL and OV_OAUTH_CLIENT_SECRET are not both set']);
        const b = createRelayEventsWorker({ db, relay, eventsUrl: events.url, clientSecret: '', tokenUrl: 'http://127.0.0.1:9/oauth/token' });
        assert.strictEqual(b.enabled, false);
        const c = createRelayEventsWorker({ db, relay, events: client, enabled: false });
        assert.deepStrictEqual([c.enabled, c.status().reason], [false, 'DISCORD_RELAY_EVENTS=off']);
        const d = createRelayEventsWorker({ db, relay: createDiscordRelay({ db, env }), events: client });
        assert.match(d.status().reason, /relay is off/);
        c.start();
        assert.strictEqual(relay.status().creates_from, 'forum');
        assert.deepStrictEqual(await c.tick(), { queued: 0 });
    });

    let before;
    await check('first start begins at the head: threads from before are never announced', async () => {
        const old1 = newThread('Older one');
        const old2 = newThread('Older two');
        events.add(threadEvent(old1));
        events.add(threadEvent(old2));
        events.add(envelope('community.paste.created', { paste_id: 'x' }));
        relay.start();   // starts the worker too (its interval is an hour here: ticks are driven by the test)
        await worker.tick();
        assert.strictEqual(relay.status().creates_from, 'events');
        const st = worker.status();
        assert.deepStrictEqual([st.enabled, st.cursor, st.latest_seq, st.started_at_seq, st.lag], [true, 3, 3, 3, 0]);
        assert.strictEqual(deliveries().length, 0);
        assert.deepStrictEqual(db.prepare('SELECT name, cursor FROM relay_cursors').all(), [{ name: CURSOR, cursor: 3 }]);
        before = events.calls.length;
    });

    let t1;
    let p1;
    await check('new events queue creates (source events, the event id) that are sent once; the forum\'s own calls queue none', async () => {
        t1 = newThread('From the stream');
        assert.strictEqual(relay.enqueueThread(t1, general), 0, 'the forum queues no creates while the worker runs');
        p1 = forumStore.addPost(db, { thread_id: t1.id, author_subject: alex, body_markdown: 'a reply via events' });
        assert.strictEqual(relay.enqueuePost(p1, t1, general), 0);
        const e1 = threadEvent(t1);
        const e2 = postEvent(p1, t1);
        events.add(e1);
        events.add(envelope('community.comment.created', { comment_id: 1 }));   // not on the relay's topics: never returned
        events.add(e2);
        assert.deepStrictEqual(await worker.tick(), { queued: 2 });
        const rows = deliveries();
        assert.deepStrictEqual(rows.map((d) => [d.action, d.source, d.event_id, d.post_id]), [['create', 'events', e1.event_id, null], ['create', 'events', e2.event_id, p1.id]]);
        assert.ok(events.calls.slice(before).every((c) => /topic=community\.thread\.\*%2Ccommunity\.post\.\*/.test(c.path) && c.auth === 'Bearer test-token'), JSON.stringify(events.calls.slice(before)));
        await settle(); await relay.drain(); await relay.drain();
        assert.deepStrictEqual(hook.hits.map((h) => h.method), ['POST', 'POST']);
        assert.match(hook.hits[1].body.content, /replied to \*\*From the stream\*\*/);
        assert.deepStrictEqual([worker.status().cursor, worker.status().lag], [6, 0]);
    });

    await check('a replay (cursor moved back) queues nothing twice and posts nothing twice', async () => {
        db.prepare('UPDATE relay_cursors SET cursor = 3 WHERE name = ?').run(CURSOR);
        assert.deepStrictEqual(await worker.tick(), { queued: 0 });
        await relay.drain();
        assert.strictEqual(hook.hits.length, 2);
        assert.strictEqual(worker.status().cursor, 6);
    });

    await check('the cursor survives a restart: a new worker carries on from it (no second "start at head")', async () => {
        const t2 = newThread('While restarting');
        events.add(threadEvent(t2));
        const again = createRelayEventsWorker({ db, relay, events: client, pollMs: 3_600_000 });
        assert.deepStrictEqual(await again.tick(), { queued: 1 });
        assert.strictEqual(again.status().started_at_seq, null);
        assert.strictEqual(deliveries().pop().thread_id, t2.id);
    });

    await check('members-only, Discord-origin, redacted and foreign events queue nothing', async () => {
        const n = deliveries().length;
        const gated = newThread('Gated', { members_only_owner: alex });
        const fromDiscord = forumStore.addPost(db, { thread_id: t1.id, origin: 'discord', body_markdown: 'hi from discord', relay_author: 'Kim' });
        const t3 = newThread('Looks public');
        events.add(threadEvent(gated, 'members'));
        events.add(threadEvent(gated));   // even a (wrongly) public-looking event: the row decides
        events.add(postEvent(fromDiscord, t1));
        events.add({ ...threadEvent(t3), source: 'live' });
        events.add({ ...threadEvent(t3), payload: { redacted: true } });
        assert.deepStrictEqual(await worker.tick(), { queued: 0 });
        assert.strictEqual(deliveries().length, n);
    });

    await check('Events down: the error shows, the cursor stays, and it catches up once Events answers', async () => {
        const t4 = newThread('After the outage');
        events.add(threadEvent(t4));
        const cursor = worker.status().cursor;
        events.state.failNext = 1;
        assert.deepStrictEqual(await worker.tick(), { queued: 0 });
        const st = worker.status();
        assert.ok(st.last_error, 'the error is shown');
        assert.strictEqual(st.cursor, cursor);
        assert.strictEqual(st.lag, st.latest_seq - cursor);
        assert.deepStrictEqual(await worker.tick(), { queued: 1 });
        assert.strictEqual(worker.status().last_error, null);
    });

    await check('a retention gap is logged and shown to staff; reading carries on after it', async () => {
        db.prepare('UPDATE relay_cursors SET cursor = 1 WHERE name = ?').run(CURSOR);
        events.state.prunedThrough = 5;
        await worker.tick();
        assert.deepStrictEqual([worker.status().last_gap.from_seq, worker.status().last_gap.to_seq], [2, 5]);
        assert.strictEqual(worker.status().cursor, events.log.length);
        events.state.prunedThrough = 0;
        assert.strictEqual(relay.status().events_worker.last_gap.to_seq, 5);
    });

    await check('the whole path in the app: API write → outbox → Events → worker → Discord, and back out on edit and delete', async () => {
        const hook2 = await startWebhooks();
        const events2 = await startEvents();
        process.env.EVENTS_URL = events2.url;
        process.env.DISCORD_RELAY_EVENTS_POLL_MS = '40';
        try {
            const t = await boot({
                authority: 'community',
                appOpts: { relayOptions: { enabled: true, env: { DISCORD_WEBHOOK_GENERAL: `${hook2.url}/api/webhooks/7/app` } }, forumLimits: { threads: { cooldownSec: 0 }, posts: { cooldownSec: 0 } } },
            });
            const outbox = require('../server/events').init(t.db, { eventsUrl: events2.url, intervalMs: 40 });
            assert.ok(outbox, 'the outbox publishes to the fake Events');
            const net = t.network;
            const samU = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
            const samJwt = net.sign({ id: 9, subject_id: samU.subject_id, username: 'sam', role: 'user' });
            const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
            const call = (p, { method = 'GET', cookie, json } = {}) => t.get(p, { method, headers: json !== undefined ? { 'content-type': 'application/json' } : {}, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
            const waitFor = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail(`timed out waiting for ${what}`); };
            assert.strictEqual((await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } })).status, 201);
            await waitFor(() => t.app.locals.relay.status().events_worker.cursor != null, 'the worker\'s first read');
            const st = (await call('/api/v1/relay/status', { cookie: adminJwt })).json();
            assert.deepStrictEqual([st.creates_from, st.events_worker.enabled], ['events', true]);
            const th = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Round trip', body: 'through Events' } });
            assert.strictEqual(th.status, 201, th.text);
            await waitFor(() => hook2.hits.length >= 1, 'the thread on Discord');
            assert.strictEqual(hook2.hits[0].path, '/api/webhooks/7/app?wait=true');
            assert.ok(events2.log.some((x) => x.event.event_type === 'community.thread.created'), 'it went through Events');
            const d = t.db.prepare('SELECT * FROM relay_deliveries').get();
            assert.deepStrictEqual([d.source, /^evt_/.test(d.event_id)], ['events', true]);
            const reply = await call(`/api/v1/spaces/general/threads/${th.json().thread.slug}/posts`, { method: 'POST', cookie: samJwt, json: { body: 'and a reply' } });
            await waitFor(() => hook2.hits.length >= 2, 'the reply on Discord');
            assert.strictEqual((await call(`/api/v1/posts/${reply.json().post.id}`, { method: 'PUT', cookie: samJwt, json: { body: 'and a reply, edited' } })).status, 200);
            await waitFor(() => hook2.hits.length >= 3, 'the edit on Discord');
            assert.strictEqual((await call(`/api/v1/spaces/general/threads/${th.json().thread.slug}`, { method: 'DELETE', cookie: samJwt })).status, 200);
            await waitFor(() => hook2.hits.length >= 5, 'the deletes on Discord');
            assert.deepStrictEqual(hook2.hits.map((h) => h.method), ['POST', 'POST', 'PATCH', 'DELETE', 'DELETE']);
            await new Promise((r) => setTimeout(r, 200));
            assert.strictEqual(hook2.hits.length, 5, 'nothing was sent twice');
            await t.app.locals.relay.stop();
            await require('../server/events').stop();
            await t.close();
        } finally {
            delete process.env.EVENTS_URL; delete process.env.DISCORD_RELAY_EVENTS_POLL_MS;
            await hook2.close(); await events2.close();
        }
    });

    await relay.stop();
    await hook.close();
    await events.close();
    done();
})();
