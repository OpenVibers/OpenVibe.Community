'use strict';
/**
 * Discord relay, inbound (relay/discord-gateway.js + relay/inbound.js), against a fake gateway:
 * HELLO → IDENTIFY (token, intents GUILD_MESSAGES | MESSAGE_CONTENT), heartbeats with the last seq,
 * RECONNECT and zombied connections resume, INVALID_SESSION identifies again, fatal close codes stop
 * it with a reason, a missing HELLO reconnects, stop() closes. Then what becomes a post: replies to
 * relayed messages (or messages in a Discord thread started from one) in mapped channels only, with
 * origin 'discord', no author subject and the Discord name; mentions defused; size and rate limits;
 * edits and deletes through the map; webhook/bot/own/system messages, unmapped channels and
 * non-replies ignored; closed threads and empty messages recorded as failures; nothing from Discord
 * ever relayed back out. Last, the app: status and failures at /api/v1/relay (staff, no token), and
 * the post on the thread page with its Discord badge.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { startWebhooks, createGateway } = require('./helpers/fake-discord');
const { openDb } = require('../server/db');
const forumStore = require('../server/forum/store');
const { createDiscordRelay } = require('../server/relay/discord');
const { createDiscordGateway, DEFAULT_URL, INTENTS } = require('../server/relay/discord-gateway');
const { createDiscordInbound, toMarkdown } = require('../server/relay/inbound');
const { createForumService } = require('../server/forum/service');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOT = '4000000000000000001';
const KIM = '4000000000000000002';
const LEE = '4000000000000000003';
let snow = 5000000000000000000n;
const nextId = () => String(snow++);

/** A scripted gateway: HELLO on open, READY on IDENTIFY, RESUMED on RESUME, ACK on heartbeat (unless paused). */
function scriptedGateway() {
    const gw = createGateway();
    gw.ack = true;
    gw.seq = 0;
    gw.onOpen = (sock) => gw.push(sock, { op: 10, d: { heartbeat_interval: 30 } });
    gw.onSend = (sock, p) => {
        if (p.op === 2) gw.push(sock, { op: 0, t: 'READY', s: ++gw.seq, d: { session_id: `sess-${gw.sockets.length}`, resume_gateway_url: 'wss://resume.discord.test', user: { id: BOT, bot: true } } });
        if (p.op === 6) gw.push(sock, { op: 0, t: 'RESUMED', s: ++gw.seq, d: {} });
        if (p.op === 1 && gw.ack) gw.push(sock, { op: 11 });
    };
    gw.dispatch = (t, d) => gw.push(gw.last(), { op: 0, t, s: ++gw.seq, d });
    return gw;
}
const waitFor = async (fn, what, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await sleep(5); } assert.fail(`timed out waiting for ${what}`); };
const sent = (gw, op) => gw.sockets.flatMap((s) => s.sent).filter((p) => p.op === op);

(async () => {
    // ── the gateway client ───────────────────────────────────
    const opts = { token: 'test-bot-token', minBackoffMs: 5, maxBackoffMs: 40, helloTimeoutMs: 150, invalidSessionMs: 5, jitter: () => 0 };

    await check('off without a token or a WebSocket client, and says why', async () => {
        const a = createDiscordGateway({ token: '' });
        assert.deepStrictEqual([a.enabled, a.status()], [false, { enabled: false, reason: 'DISCORD_BOT_TOKEN is not set' }]);
        const b = createDiscordGateway({ token: 'x', WebSocketImpl: null });
        assert.match(b.status().reason, /no built-in WebSocket/);
        b.start();
        assert.strictEqual(typeof globalThis.WebSocket, 'function', 'Node 22 has the client the gateway uses');
    });

    await check('HELLO → IDENTIFY with the token and intents; heartbeats carry the last seq and are ACKed; READY is ready', async () => {
        const gw = scriptedGateway();
        const seen = [];
        const g = createDiscordGateway({ ...opts, WebSocketImpl: gw.WebSocket, onDispatch: (t, d) => { seen.push([t, d.id]); } });
        g.start();
        await waitFor(() => g.status().state === 'ready', 'READY');
        assert.strictEqual(gw.sockets[0].url, DEFAULT_URL);
        const [identify] = sent(gw, 2);
        assert.deepStrictEqual([identify.d.token, identify.d.intents], ['test-bot-token', INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT]);
        assert.strictEqual(INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT, 33280);
        await waitFor(() => sent(gw, 1).length >= 2, 'two heartbeats');
        assert.strictEqual(sent(gw, 1).pop().d, 1, 'the last seq');
        gw.dispatch('MESSAGE_CREATE', { id: '1' });
        gw.dispatch('GUILD_CREATE', { id: '2' });   // not a message event: dropped here
        gw.dispatch('MESSAGE_DELETE', { id: '3' });
        assert.deepStrictEqual(seen, [['MESSAGE_CREATE', '1'], ['MESSAGE_DELETE', '3']]);
        const st = g.status();
        assert.deepStrictEqual([st.state, st.session, st.bot_user_id, st.events_handled], ['ready', true, BOT, 2]);
        assert.ok(!JSON.stringify(st).includes('test-bot-token'), 'the token never shows');
        await g.stop();
        assert.strictEqual(gw.sockets[0].closedWith, 1000);
        assert.strictEqual(g.status().state, 'stopped');
        await sleep(60);
        assert.strictEqual(gw.sockets.length, 1, 'no reconnect after stop()');
    });

    await check('RECONNECT, a zombied connection and an abnormal close all RESUME on the resume URL with the session and seq', async () => {
        const gw = scriptedGateway();
        const g = createDiscordGateway({ ...opts, WebSocketImpl: gw.WebSocket });
        g.start();
        await waitFor(() => g.status().state === 'ready', 'READY');
        gw.dispatch('MESSAGE_CREATE', { id: '10' });
        gw.push(gw.sockets[0], { op: 7, d: null });
        await waitFor(() => gw.sockets.length === 2 && sent(gw, 6).length === 1, 'a resume');
        assert.strictEqual(gw.sockets[0].closedWith, 4000, 'closed with a non-1000 code, so the session stays resumable');
        assert.strictEqual(gw.sockets[1].url, 'wss://resume.discord.test/?v=10&encoding=json');
        assert.deepStrictEqual(sent(gw, 6)[0].d, { token: 'test-bot-token', session_id: 'sess-1', seq: 2 });
        await waitFor(() => g.status().state === 'ready', 'RESUMED');
        // No ACK: the next heartbeat finds the last one unanswered and reconnects.
        gw.ack = false;
        await waitFor(() => gw.sockets.length === 3, 'a reconnect after a missing ACK', 1000);
        gw.ack = true;
        await waitFor(() => sent(gw, 6).length === 2, 'a second resume');
        assert.match(g.status().last_reconnect.reason, /no heartbeat ACK \(zombied connection\)/);
        // An abnormal close (1006) resumes too.
        await waitFor(() => g.status().state === 'ready', 'ready again');
        gw.drop(gw.last(), 1006);
        await waitFor(() => sent(gw, 6).length === 3, 'a third resume');
        assert.strictEqual(sent(gw, 2).length, 1, 'identified only once');
        await g.stop();
    });

    await check('INVALID_SESSION (not resumable) and close codes 4007/4009 identify afresh; no HELLO reconnects', async () => {
        const gw = scriptedGateway();
        const g = createDiscordGateway({ ...opts, WebSocketImpl: gw.WebSocket });
        g.start();
        await waitFor(() => g.status().state === 'ready', 'READY');
        gw.push(gw.last(), { op: 9, d: false });
        await waitFor(() => sent(gw, 2).length === 2, 'a second IDENTIFY');
        assert.strictEqual(gw.last().url, DEFAULT_URL, 'a fresh session starts on the main URL');
        await waitFor(() => g.status().state === 'ready', 'READY again');
        gw.drop(gw.last(), 4009);
        await waitFor(() => sent(gw, 2).length === 3, 'IDENTIFY after 4009');
        await waitFor(() => g.status().state === 'ready', 'READY after 4009');
        // A gateway that never says HELLO.
        gw.onOpen = null;
        gw.drop(gw.last(), 1001);
        await waitFor(() => gw.sockets.length >= 5, 'a reconnect after the HELLO timeout', 1500);
        assert.match(g.status().last_error, /no HELLO/);
        await g.stop();
    });

    await check('fatal close codes stop it with the reason (4004 a wrong token, 4014 the MESSAGE CONTENT intent)', async () => {
        for (const [code, re] of [[4004, /DISCORD_BOT_TOKEN is wrong/], [4014, /MESSAGE CONTENT intent/]]) {
            const gw = scriptedGateway();
            const g = createDiscordGateway({ ...opts, WebSocketImpl: gw.WebSocket });
            g.start();
            await waitFor(() => g.status().state === 'ready', 'READY');
            gw.drop(gw.last(), code);
            await sleep(80);
            assert.strictEqual(gw.sockets.length, 1, `no reconnect after ${code}`);
            assert.strictEqual(g.status().state, 'failed');
            assert.match(g.status().last_error, re);
            await g.stop();
        }
    });

    // ── inbound: what becomes a post ────────────────────────
    const hook = await startWebhooks();
    const db = openDb(':memory:');
    const general = forumStore.getSpace(db, 'general');
    const relay = createDiscordRelay({ db, config: { baseUrl: 'https://openvibe.community' }, env: { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/1/general` }, enabled: true });
    relay.addMapping({ space_id: general.id, webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL', inbound: true });
    const CHANNEL = '2000000000000000001';   // the fake webhook 1's channel (learned on the first send)
    const inbound = createDiscordInbound({ db, perMinute: 3, maxChars: 200 });
    const forum = createForumService({ db, relay, limits: { threads: { cooldownSec: 0, perMinute: 100 }, posts: { cooldownSec: 0, perMinute: 100 }, threadsPerDay: 0 } });
    const sam = ids.newId('user');
    const samV = { kind: 'user', subject: sam, staff: false };
    const settle = async () => { await new Promise((r) => setImmediate(r)); await relay.drain(); await relay.drain(); };
    const { thread } = await forum.createThread(samV, 'general', { title: 'Talk to Discord', body: 'Say hi over there' });
    await settle();
    const threadMsg = db.prepare("SELECT external_message_id FROM relay_message_map WHERE local_type = 'thread' AND local_id = ?").get(thread.id).external_message_id;
    const failures = () => db.prepare('SELECT * FROM relay_inbound_failures ORDER BY id').all();
    const msg = (extra = {}) => ({ id: nextId(), channel_id: CHANNEL, guild_id: '6000000000000000001', type: 19, content: 'hello from Discord', author: { id: KIM, username: 'kim', global_name: 'Kim' }, message_reference: { message_id: threadMsg, channel_id: CHANNEL }, mentions: [], attachments: [], ...extra });
    const postsOf = (tid) => db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY id').all(tid);

    await check('a Discord reply to a relayed message becomes a post: origin discord, nobody on the site, the Discord name, mapped', async () => {
        const m = msg({ content: 'Hi <@4000000000000000003> and <@&4000000000000000009> in <#4000000000000000010> @everyone <:wave:4000000000000000011> <t:1790000000:R>', mentions: [{ id: LEE, username: 'lee', global_name: 'Lee' }], member: { nick: 'Kim (mod)' } });
        const r = inbound.handle('MESSAGE_CREATE', m, { botUserId: BOT });
        assert.strictEqual(r.status, 'applied', JSON.stringify(r));
        const p = forumStore.getPost(db, r.post_id);
        assert.deepStrictEqual([p.thread_id, p.origin, p.author_subject, p.relay_author], [thread.id, 'discord', null, 'Kim (mod)']);
        assert.strictEqual(p.body_markdown, 'Hi @Lee and @role in #channel @\u200beveryone :wave: 2026-09-21 14:13 UTC');
        const row = db.prepare('SELECT * FROM relay_message_map WHERE external_message_id = ?').get(m.id);
        assert.deepStrictEqual([row.direction, row.local_type, row.local_id, row.thread_id, row.external_channel_id], ['in', 'post', p.id, thread.id, CHANNEL]);
        const shown = (await forum.getThread(samV, 'general', thread.slug, {})).posts.find((x) => x.id === p.id);
        assert.deepStrictEqual([shown.author.display_name, shown.author.is_relay, shown.author.subject, shown.origin], ['Kim (mod)', true, null, 'discord']);
        // The same message again (a gateway replay) is not taken twice.
        assert.deepStrictEqual(inbound.handle('MESSAGE_CREATE', m, { botUserId: BOT }), { status: 'ignored', reason: 'already relayed' });
    });

    await check('a message in a Discord thread started from a relayed message becomes a post in that thread', async () => {
        const r = inbound.handle('MESSAGE_CREATE', msg({ channel_id: threadMsg, type: 0, message_reference: undefined, content: 'in the Discord thread' }));
        assert.strictEqual(r.status, 'applied');
        assert.strictEqual(forumStore.getPost(db, r.post_id).thread_id, thread.id);
        // A reply to that Discord-origin post (mapped 'in') lands in the same thread too.
        const inId = db.prepare("SELECT external_message_id FROM relay_message_map WHERE local_id = ? AND direction = 'in'").get(r.post_id).external_message_id;
        const r2 = inbound.handle('MESSAGE_CREATE', msg({ channel_id: threadMsg, message_reference: { message_id: inId }, content: 'reply to a reply', author: { id: LEE, username: 'lee' } }));
        assert.strictEqual(forumStore.getPost(db, r2.post_id).relay_author, 'lee');
    });

    await check('everything else is ignored: webhooks (the relay\'s own), bots, the bot itself, system messages, non-replies, other channels, inbound off', async () => {
        const n = postsOf(thread.id).length;
        const cases = [
            [msg({ webhook_id: '1' }), /webhook message/],
            [msg({ author: { id: LEE, username: 'lee', bot: true } }), /bot or system/],
            [msg({ author: { id: BOT, username: 'relaybot' } }), /bot or system/],
            [msg({ type: 7 }), /not a plain message/],
            [msg({ message_reference: undefined, type: 0 }), /not a reply to a relayed message/],
            [msg({ message_reference: { message_id: '9999999999999999999' } }), /not a reply to a relayed message/],
            [msg({ channel_id: '7000000000000000001' }), /not a reply to a relayed message/],
            [msg({ type: 0, content: '', message_reference: { type: 1, message_id: threadMsg, channel_id: CHANNEL } }), /not a reply to a relayed message/],   // a forward
        ];
        for (const [m, re] of cases) {
            const r = inbound.handle('MESSAGE_CREATE', m, { botUserId: BOT });
            assert.strictEqual(r.status, 'ignored', JSON.stringify(m));
            assert.match(r.reason, re);
        }
        relay.updateMapping(1, { inbound: false });
        assert.match(inbound.handle('MESSAGE_CREATE', msg()).reason, /inbound is off/);
        relay.updateMapping(1, { inbound: true, discord_channel_id: '7000000000000000002' });
        assert.match(inbound.handle('MESSAGE_CREATE', msg()).reason, /not a mapped channel/);
        relay.updateMapping(1, { discord_channel_id: CHANNEL });
        assert.strictEqual(postsOf(thread.id).length, n);
        assert.strictEqual(failures().length, 0, 'ignoring is not a failure');
    });

    await check('limits: a long message is cut, a fourth message a minute is refused, an empty one explains the intent; attachments are noted', async () => {
        const long = inbound.handle('MESSAGE_CREATE', msg({ author: { id: '4000000000000000020', username: 'long' }, content: 'x'.repeat(500) }));
        const body = forumStore.getPost(db, long.post_id).body_markdown;
        assert.strictEqual(body.length, 200);
        assert.ok(body.endsWith('…'));
        const talker = { id: '4000000000000000021', username: 'talker' };
        for (let i = 0; i < 3; i++) assert.strictEqual(inbound.handle('MESSAGE_CREATE', msg({ author: talker, content: `m${i}` })).status, 'applied');
        const r = inbound.handle('MESSAGE_CREATE', msg({ author: talker, content: 'one too many' }));
        assert.deepStrictEqual([r.status, r.error], ['failed', 'rate limited']);
        const empty = inbound.handle('MESSAGE_CREATE', msg({ author: { id: '4000000000000000022', username: 'quiet' }, content: '' }));
        assert.match(empty.error, /MESSAGE CONTENT intent/);
        const pic = inbound.handle('MESSAGE_CREATE', msg({ author: { id: '4000000000000000023', username: 'pics' }, content: '', attachments: [{ id: '1' }, { id: '2' }] }));
        assert.strictEqual(forumStore.getPost(db, pic.post_id).body_markdown, '_(2 attachments on Discord)_');
        const f = failures();
        assert.deepStrictEqual(f.map((x) => x.error.slice(0, 12)), ['rate limited', 'the message ']);
        assert.deepStrictEqual([f[0].event, f[0].external_author_id, f[0].mapping_id], ['MESSAGE_CREATE', talker.id, 1]);
        assert.ok(!JSON.stringify(f).includes('one too many'), 'failures never keep the text');
        assert.strictEqual(toMarkdown({ content: '  <@123456789012345678>  ' }), '@someone');
    });

    await check('closed threads refuse replies from Discord and say why: locked, members-only, deleted', async () => {
        const t = (await forum.createThread(samV, 'general', { title: 'Soon closed', body: 'x' })).thread;
        await settle();
        const anchor = db.prepare("SELECT external_message_id FROM relay_message_map WHERE local_type = 'thread' AND local_id = ?").get(t.id).external_message_id;
        const to = (extra = {}) => msg({ author: { id: '4000000000000000030', username: 'late' }, message_reference: { message_id: anchor }, ...extra });
        forumStore.setThreadFlags(db, t.id, { locked: true });
        assert.strictEqual(inbound.handle('MESSAGE_CREATE', to()).error, 'the thread is locked');
        forumStore.setThreadFlags(db, t.id, { locked: false });
        forumStore.setThreadMembersOnly(db, t.id, sam);
        assert.strictEqual(inbound.handle('MESSAGE_CREATE', to()).error, 'the thread is not public');
        forumStore.setThreadMembersOnly(db, t.id, null);
        forumStore.softDeleteThread(db, t.id);
        assert.strictEqual(inbound.handle('MESSAGE_CREATE', to()).error, 'the thread was deleted');
        assert.strictEqual(postsOf(t.id).length, 1, 'only the opening post');
    });

    await check('edits and deletes on Discord follow through the map; a delete of the relay\'s own message leaves the thread', async () => {
        const m = msg({ author: { id: '4000000000000000040', username: 'editor' }, content: 'first words' });
        const { post_id: pid } = inbound.handle('MESSAGE_CREATE', m);
        const r = inbound.handle('MESSAGE_UPDATE', { id: m.id, channel_id: CHANNEL, content: 'second words <@4000000000000000003>', mentions: [{ id: LEE, username: 'lee' }], edited_timestamp: new Date().toISOString() });
        assert.strictEqual(r.status, 'applied');
        const p = forumStore.getPost(db, pid);
        assert.deepStrictEqual([p.body_markdown, p.revision], ['second words @lee', 2]);
        assert.deepStrictEqual(forumStore.listPostVersions(db, pid).map((v) => v.edited_by), [null, 'discord']);
        assert.match(inbound.handle('MESSAGE_UPDATE', { id: m.id, channel_id: CHANNEL, embeds: [] }).reason, /no text change/);
        assert.match(inbound.handle('MESSAGE_UPDATE', { id: threadMsg, channel_id: CHANNEL, content: 'edited on Discord?' }).reason, /relay's own/);
        const other = inbound.handle('MESSAGE_CREATE', msg({ author: { id: '4000000000000000041', username: 'bulk' }, content: 'bulk me' }));
        const otherId = db.prepare("SELECT external_message_id FROM relay_message_map WHERE local_id = ? AND direction = 'in'").get(other.post_id).external_message_id;
        assert.strictEqual(inbound.handle('MESSAGE_DELETE', { id: m.id, channel_id: CHANNEL }).status, 'applied');
        assert.ok(forumStore.getPost(db, pid).deleted_at, 'the post is deleted');
        const bulk = inbound.handle('MESSAGE_DELETE_BULK', { ids: [otherId, '1234567890123456789'], channel_id: CHANNEL });
        assert.deepStrictEqual(bulk.map((x) => x.status), ['applied', 'ignored']);
        assert.ok(forumStore.getPost(db, other.post_id).deleted_at);
        // A moderator on Discord removed the relay's announcement: the map knows, the thread stays, no edit goes there again.
        assert.match(inbound.handle('MESSAGE_DELETE', { id: threadMsg, channel_id: CHANNEL }).note, /thread stays/);
        assert.ok(forumStore.getThread(db, thread.id), 'the thread is still here');
        assert.ok(db.prepare('SELECT external_deleted_at FROM relay_message_map WHERE external_message_id = ?').get(threadMsg).external_deleted_at);
        assert.strictEqual(relay.enqueueEdit(forumStore.getPost(db, db.prepare('SELECT id FROM posts WHERE thread_id = ? AND is_opening = 1').get(thread.id).id)), 0);
    });

    await check('loop prevention: nothing from Discord is ever relayed back out', async () => {
        await settle();
        const before = hook.hits.length;
        const fromDiscord = postsOf(thread.id).filter((p) => p.origin === 'discord');
        assert.ok(fromDiscord.length >= 5);
        for (const p of fromDiscord) assert.strictEqual(relay.enqueuePost(p, forumStore.getThread(db, thread.id), general), 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM relay_deliveries WHERE post_id IN (SELECT id FROM posts WHERE origin = \'discord\')').get().n, 0);
        await settle();
        assert.strictEqual(hook.hits.length, before, 'no webhook call for anything that came from Discord');
    });

    await check('the app: the gateway starts with the relay; status and failures for staff only, without the token; the post shows with a Discord badge', async () => {
        const gw = scriptedGateway();
        process.env.DISCORD_RELAY_INBOUND = 'on';
        process.env.DISCORD_BOT_TOKEN = 'app-bot-token-not-real';
        let t;
        try {
            t = await boot({
                authority: 'community',
                appOpts: { relayOptions: { enabled: true, env: { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/5/app` } }, gatewayOptions: { WebSocketImpl: gw.WebSocket, minBackoffMs: 5, jitter: () => 0 }, forumLimits: { threads: { cooldownSec: 0 } } },
            });
        } finally { delete process.env.DISCORD_RELAY_INBOUND; delete process.env.DISCORD_BOT_TOKEN; }
        const net = t.network;
        const samU = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
        const samJwt = net.sign({ id: 9, subject_id: samU.subject_id, username: 'sam', role: 'user' });
        const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
        const call = (p, { method = 'GET', cookie, json } = {}) => t.get(p, { method, headers: json !== undefined ? { 'content-type': 'application/json' } : {}, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
        await waitFor(() => t.app.locals.relay.status().inbound.state === 'ready', 'the app\'s gateway READY');
        assert.strictEqual(sent(gw, 2)[0].d.token, 'app-bot-token-not-real');
        const m = await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL', inbound: true } });
        assert.strictEqual(m.json().mapping.inbound, true);
        const th = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Ask Discord', body: 'what do you think?' } });
        await waitFor(() => t.db.prepare("SELECT 1 FROM relay_message_map WHERE local_type = 'thread'").get(), 'the thread on Discord');
        const anchor = t.db.prepare("SELECT external_message_id, external_channel_id FROM relay_message_map WHERE local_type = 'thread'").get();
        gw.dispatch('MESSAGE_CREATE', { id: nextId(), channel_id: anchor.external_channel_id, type: 19, content: 'Looks **great**', author: { id: KIM, username: 'kim', global_name: 'Kim' }, message_reference: { message_id: anchor.external_message_id } });
        const locked = nextId();
        const page = await call(`/s/general/t/${th.json().thread.slug}`);
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('badge-relay') && page.text.includes('Kim') && page.text.includes('<strong>great</strong>'), 'the reply shows with its Discord badge');
        t.db.prepare('UPDATE threads SET locked = 1').run();
        gw.dispatch('MESSAGE_CREATE', { id: locked, channel_id: anchor.external_channel_id, type: 19, content: 'too late', author: { id: KIM, username: 'kim' }, message_reference: { message_id: anchor.external_message_id } });
        assert.strictEqual((await call('/api/v1/relay/inbound', { cookie: samJwt })).status, 403);
        const inb = await call('/api/v1/relay/inbound', { cookie: adminJwt });
        assert.strictEqual(inb.status, 200);
        assert.deepStrictEqual(inb.json().failures.map((f) => [f.error, f.discord.message_id, f.mapping.space]), [['the thread is locked', locked, 'general']]);
        assert.strictEqual((await call(`/api/v1/relay/inbound/${inb.json().failures[0].id}/dismiss`, { method: 'POST', cookie: adminJwt })).status, 200);
        assert.strictEqual((await call('/api/v1/relay/inbound', { cookie: adminJwt })).json().failures.length, 0);
        assert.strictEqual((await call('/api/v1/relay/inbound?all=1', { cookie: adminJwt })).json().failures.length, 1);
        const st = await call('/api/v1/relay/status', { cookie: adminJwt });
        assert.deepStrictEqual([st.json().inbound.enabled, st.json().inbound.state, st.json().inbound.handled.applied, st.json().inbound_failures], [true, 'ready', 1, 0]);
        assert.ok(!(st.text + inb.text + (await call('/api/ready')).text).includes('app-bot-token-not-real'), 'the token never shows');
        await t.app.locals.relay.stop();
        assert.strictEqual(gw.last().closedWith, 1000);
        await t.close();
    });

    await hook.close();
    done();
})();
