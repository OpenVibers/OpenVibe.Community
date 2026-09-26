'use strict';
/**
 * Discord relay, outbound (relay/discord.js): off unless DISCORD_RELAY_ENABLED; one delivery per
 * dedupe key; the webhook URL comes from the environment variable a mapping names; creates are sent
 * with ?wait=true and the answer's message id goes into the external message map (unique both ways);
 * replies follow their thread (into the mapping's Discord thread when it names one); edits PATCH and
 * deletes DELETE through the map; retries with backoff on 5xx/429/network errors, then the dead letter
 * ('failed') that staff retry or drop; loop prevention for Discord-origin threads and posts; members,
 * staff and VIP members-only content never relayed (and deleted when gated later); the staff API;
 * the one-time rebuild of an older relay_deliveries table. A fake Discord stands in for the webhooks;
 * the relay's clock is injected so backoff is tested without waiting. The forum queues creates
 * directly here (no Events worker: see relay-events.test.js).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { startWebhooks } = require('./helpers/fake-discord');
const { openDb } = require('../server/db');
const forumStore = require('../server/forum/store');
const { createDiscordRelay } = require('../server/relay/discord');
const { createForumService } = require('../server/forum/service');
const { sqlTime } = require('../server/http/v1');

(async () => {
    const hook = await startWebhooks();
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
    const mapOf = (type, id) => db.prepare('SELECT * FROM relay_message_map WHERE local_type = ? AND local_id = ? ORDER BY id').all(type, id);
    const settle = () => new Promise((r) => setImmediate(r));
    const EMPTY = { delivered: 0, retry: 0, failed: 0, skipped: 0 };

    await check('off by default: nothing is queued or sent', async () => {
        const off = createDiscordRelay({ db, env, now });
        assert.strictEqual(off.enabled, false);
        const th = newThread(general, 'Quiet thread');
        assert.strictEqual(off.enqueueThread(th, general), 0);
        assert.strictEqual(off.enqueuePost(forumStore.addPost(db, { thread_id: th.id, author_subject: alex, body_markdown: 'shh' }), th, general), 0);
        assert.deepStrictEqual(await off.drain(), EMPTY);
        assert.strictEqual(deliveries().length, 0);
        const st = off.status();
        assert.deepStrictEqual([st.enabled, st.events_worker.enabled, st.inbound.enabled], [false, false, false]);
    });

    await check('a new thread is posted once with ?wait=true, attribution, a link and no mentions; its message id is mapped', async () => {
        const th = newThread(general, 'Relay me <please>');
        assert.strictEqual(relay.enqueueThread(th, general), 1);
        assert.strictEqual(relay.enqueueThread(th, general), 0, 'dedupe key per (thread, mapping)');
        await settle();
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1);
        const msg = hook.hits[0];
        assert.strictEqual(msg.method, 'POST');
        assert.strictEqual(msg.path, '/api/webhooks/1/general?wait=true');
        assert.deepStrictEqual(msg.body.allowed_mentions, { parse: [] });
        assert.match(msg.body.content, /^New thread in \*\*s\/general\*\* by Alex @\u200beveryone: <https:\/\/openvibe\.community\/s\/general\/t\/relay-me-please>$/);
        assert.strictEqual(msg.body.embeds[0].title, 'Relay me <please>');
        assert.strictEqual(msg.body.embeds[0].url, 'https://openvibe.community/s/general/t/relay-me-please');
        assert.strictEqual(msg.body.embeds[0].description, 'Hello there, link');
        assert.strictEqual(msg.body.embeds[0].footer.text, 'OpenVibe.Community · s/general');
        const d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status, d.dedupe_key, d.action, d.source], ['delivered', 1, 200, `thread:${th.id}:mapping:1`, 'create', 'direct']);
        const [row] = mapOf('thread', th.id);
        assert.deepStrictEqual([row.platform, row.direction, row.mapping_id, row.thread_id, row.external_channel_id, row.external_thread_id, row.external_webhook_id],
            ['discord', 'out', 1, th.id, '2000000000000000001', null, '1']);
        assert.ok(hook.messages.has(row.external_message_id));
        assert.strictEqual(db.prepare('SELECT discord_channel_id FROM relay_mappings WHERE id = 1').get().discord_channel_id, '2000000000000000001', 'the mapping learned its channel');
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1, 'a delivered thread is never sent again');
        // Even a create queued again under another key is not sent twice: the map already has it.
        db.prepare("INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, next_attempt_at) VALUES (?, 1, 'replay-of-the-same', ?)").run(th.id, sqlTime(clock));
        await relay.drain();
        assert.strictEqual(hook.hits.length, 1);
        assert.deepStrictEqual([deliveries().pop().status, deliveries().pop().last_error], ['delivered', 'already on Discord']);
    });

    await check('the external message map is unique both ways', async () => {
        const th = newThread(general, 'Unique map');
        const put = (mapping, type, local, external) => db.prepare(`INSERT INTO relay_message_map (mapping_id, direction, local_type, local_id, thread_id, external_channel_id, external_message_id)
                                                                    VALUES (?, 'out', ?, ?, ?, '2000000000000000001', ?)`).run(mapping, type, local, th.id, external);
        put(1, 'thread', th.id, '1900000000000000001');
        assert.throws(() => put(2, 'post', 999, '1900000000000000001'), /UNIQUE/, 'one Discord message is one local object');
        assert.throws(() => put(1, 'thread', th.id, '1900000000000000002'), /UNIQUE/, 'one local object is one message per mapping');
        put(2, 'thread', th.id, '1900000000000000003');   // the same thread through another mapping is fine
        db.prepare('DELETE FROM relay_message_map WHERE thread_id = ?').run(th.id);
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

    await check('429 honours retry_after and holds that webhook for the pass; used-up attempts end as failed; other 4xx fail at once', async () => {
        const th = newThread(general, 'Rate limited');
        const th2 = newThread(general, 'Behind it');
        hook.plan.push({ status: 429, body: { message: 'You are being rate limited.', retry_after: 300 } });
        relay.enqueueThread(th, general);
        relay.enqueueThread(th2, general);
        const before = hook.hits.length;
        await settle(); await relay.drain();
        assert.strictEqual(hook.hits.length, before + 1, 'the next delivery to the same webhook waits for the next pass');
        let d = deliveries().find((x) => x.thread_id === th.id);
        assert.strictEqual(d.status, 'pending');
        assert.strictEqual(Date.parse(`${d.next_attempt_at.replace(' ', 'T')}Z`) - clock, 300_000);
        await relay.drain();
        assert.strictEqual(deliveries().find((x) => x.thread_id === th2.id).status, 'delivered');
        clock += 300_000;
        hook.plan.push({ status: 503 }, { status: 503 });
        await relay.drain();
        clock += 10 * 60_000;
        await relay.drain();
        d = deliveries().find((x) => x.thread_id === th.id);
        assert.deepStrictEqual([d.status, d.attempts, d.last_status], ['failed', 3, 503]);

        const gone = newThread(general, 'Webhook deleted');
        hook.plan.push({ status: 404, body: { message: 'Unknown Webhook', code: 10015 } });
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
        const everything = JSON.stringify(db.prepare('SELECT * FROM relay_mappings').all()) + JSON.stringify(deliveries()) + JSON.stringify(db.prepare('SELECT * FROM relay_message_map').all());
        assert.ok(!everything.includes('/api/webhooks/'), 'no webhook URL stored anywhere');
    });

    await check('loop prevention: Discord-origin threads and posts are never relayed; members/staff spaces never leave the site', async () => {
        const before = hook.hits.length;
        const fromDiscord = newThread(general, 'Came from Discord', { origin: 'discord' });
        assert.strictEqual(relay.enqueueThread(fromDiscord, general), 0);
        // Even a delivery row that got queued somehow is refused at send time.
        db.prepare('INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, next_attempt_at) VALUES (?, 1, ?, ?)').run(fromDiscord.id, `thread:${fromDiscord.id}:mapping:1`, sqlTime(clock));
        await relay.drain();
        const d = deliveries().find((x) => x.thread_id === fromDiscord.id);
        assert.deepStrictEqual([d.status, d.last_error], ['failed', 'loop prevention: thread came from Discord']);
        // A reply that came from Discord, in a thread that is on Discord, stays here too.
        const th = newThread(general, 'Mixed replies');
        relay.enqueueThread(th, general);
        await settle(); await relay.drain();
        const inbound = forumStore.addPost(db, { thread_id: th.id, origin: 'discord', body_markdown: 'from discord', relay_author: 'Kim' });
        assert.strictEqual(relay.enqueuePost(inbound, th, general), 0);
        db.prepare('INSERT INTO relay_deliveries (thread_id, post_id, mapping_id, dedupe_key, next_attempt_at) VALUES (?, ?, 1, ?, ?)').run(th.id, inbound.id, `post:${inbound.id}:mapping:1`, sqlTime(clock));
        await relay.drain();
        assert.deepStrictEqual([deliveries().pop().status, deliveries().pop().last_error], ['failed', 'loop prevention: post came from Discord']);
        db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members')").run();
        const ins = forumStore.getSpace(db, 'insiders');
        relay.addMapping({ space_id: ins.id, webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' });
        assert.strictEqual(relay.enqueueThread(newThread(ins, 'Members only'), ins), 0);
        assert.strictEqual(hook.hits.length, before + 1, 'only the public thread went out');
    });

    await check('disabled mappings queue nothing; retry() puts a failed delivery back with a fresh budget; drop() keeps it as dropped', async () => {
        relay.setMappingEnabled(1, false);
        assert.strictEqual(relay.enqueueThread(newThread(general, 'Mapping off'), general), 0);
        relay.setMappingEnabled(1, true);
        const failed = deliveries().find((x) => x.status === 'failed' && x.last_status === 404);
        assert.strictEqual(relay.retry(failed.id), 1);
        await settle(); await relay.drain();
        assert.strictEqual(deliveries().find((x) => x.id === failed.id).status, 'delivered');
        assert.strictEqual(relay.retry(failed.id), 0, 'delivered ones stay delivered');
        const dead = deliveries().find((x) => x.status === 'failed' && x.last_status === 503);
        assert.strictEqual(relay.drop(dead.id), 1);
        assert.strictEqual(deliveries().find((x) => x.id === dead.id).status, 'dropped');
        assert.strictEqual(relay.drop(dead.id), 0);
        assert.strictEqual(relay.status().deliveries.dropped, 1);
    });

    // ── replies, edits and deletes through the forum service ─────────────────────────
    const forum = createForumService({ db, relay, limits: { threads: { cooldownSec: 0, perMinute: 100 }, posts: { cooldownSec: 0, perMinute: 100 }, threadsPerDay: 0 } });
    const sam = ids.newId('user');
    require('../server/pastes/store').upsertProjection(db, { subject_id: sam, username: 'sam', display_name: 'Sam' });
    const samV = { kind: 'user', subject: sam, staff: false };
    const alexV = { kind: 'user', subject: alex, staff: false };
    const modV = { kind: 'user', subject: ids.newId('user'), staff: true };
    const drainAll = async () => { await settle(); for (let i = 0; i < 5; i++) await relay.drain(); };

    await check('replies follow their thread: one message per reply, linked to the post, mapped; a reply waits for its thread\'s message', async () => {
        hook.hits.length = 0;
        const { thread } = await forum.createThread(samV, 'general', { title: 'Replies go too', body: 'Opening words' });
        const { post } = await forum.reply(alexV, 'general', thread.slug, { body: 'First **reply**' });
        await drainAll();
        assert.deepStrictEqual(hook.hits.map((h) => h.method), ['POST', 'POST']);
        const r = hook.hits[1];
        assert.strictEqual(r.path, '/api/webhooks/1/general?wait=true');
        assert.match(r.body.content, /^Alex @\u200beveryone replied to \*\*Replies go too\*\* in \*\*s\/general\*\*: <https:\/\/openvibe\.community\/s\/general\/t\/replies-go-too#post-\d+>$/);
        assert.strictEqual(r.body.embeds[0].description, 'First reply');
        assert.deepStrictEqual(r.body.allowed_mentions, { parse: [] });
        const [row] = mapOf('post', post.id);
        assert.deepStrictEqual([row.direction, row.thread_id], ['out', thread.id]);
        // The thread's own message failing for now: the reply waits, without using an attempt.
        hook.hits.length = 0;
        hook.plan.push({ status: 500 });
        const t2 = await forum.createThread(samV, 'general', { title: 'Thread first', body: 'x' });
        const p2 = (await forum.reply(alexV, 'general', t2.thread.slug, { body: 'waits' })).post;
        await drainAll();
        const reply = deliveries().find((x) => x.post_id === p2.id);
        assert.deepStrictEqual([reply.status, reply.attempts, reply.last_error], ['pending', 0, "waiting for the thread's own message"]);
        assert.strictEqual(hook.hits.length, 1, 'only the thread was tried');
        clock += 60_000;
        await drainAll();
        assert.deepStrictEqual(hook.hits.map((h) => h.body.content.startsWith('New thread') ? 'thread' : 'reply'), ['thread', 'thread', 'reply'], 'the thread, then its reply');
        assert.strictEqual(deliveries().find((x) => x.post_id === p2.id).status, 'delivered');
        // A thread that was never relayed (made before the mapping): its replies are not either.
        const old = newThread(general, 'Before the mapping');
        assert.strictEqual(relay.enqueuePost(forumStore.addPost(db, { thread_id: old.id, author_subject: sam, body_markdown: 'late' }), old, general), 0);
    });

    await check('a mapping that names a Discord thread posts into it (thread_id) and edits and deletes there', async () => {
        hook.hits.length = 0;
        relay.updateMapping(2, { discord_thread_id: '3000000000000000002' });
        const { thread } = await forum.createThread(samV, 'feedback', { title: 'Into a Discord thread', body: 'hi' });
        const { post } = await forum.reply(samV, 'feedback', thread.slug, { body: 'reply in thread' });
        await drainAll();
        assert.deepStrictEqual(hook.hits.map((h) => h.path), ['/api/webhooks/2/feedback?wait=true&thread_id=3000000000000000002', '/api/webhooks/2/feedback?wait=true&thread_id=3000000000000000002'], JSON.stringify(hook.hits.map((h) => h.path)));
        const [row] = mapOf('post', post.id);
        assert.deepStrictEqual([row.external_channel_id, row.external_thread_id], ['3000000000000000002', '3000000000000000002']);
        await forum.editPost(samV, post.id, { body: 'reply in thread, edited' });
        await drainAll();
        await forum.deletePost(samV, post.id);
        await drainAll();
        assert.deepStrictEqual(hook.hits.slice(2).map((h) => `${h.method} ${h.path}`), [
            `PATCH /api/webhooks/2/feedback/messages/${row.external_message_id}?thread_id=3000000000000000002`,
            `DELETE /api/webhooks/2/feedback/messages/${row.external_message_id}?thread_id=3000000000000000002`,
        ]);
        assert.strictEqual(db.prepare('SELECT discord_channel_id FROM relay_mappings WHERE id = 2').get().discord_channel_id, '2000000000000000002', 'the channel learned before stays');
        relay.updateMapping(2, { discord_thread_id: null });
    });

    await check('edits follow through the map: a reply\'s message and, for the opening post, the thread\'s message are PATCHed', async () => {
        hook.hits.length = 0;
        const { thread, post: opening } = await forum.createThread(samV, 'general', { title: 'Edit me', body: 'Version one' });
        const { post } = await forum.reply(samV, 'general', thread.slug, { body: 'Reply one' });
        await drainAll();
        const threadMsg = mapOf('thread', thread.id)[0].external_message_id;
        const postMsg = mapOf('post', post.id)[0].external_message_id;
        await forum.editPost(samV, post.id, { body: 'Reply **two**' });
        await forum.editPost(samV, opening.id, { body: 'Version two' });
        await forum.editPost(samV, opening.id, { body: 'Version two' });   // no change: no revision, nothing queued
        await drainAll();
        const edits = hook.hits.filter((h) => h.method === 'PATCH');
        assert.deepStrictEqual(edits.map((h) => h.pathname), [`/api/webhooks/1/general/messages/${postMsg}`, `/api/webhooks/1/general/messages/${threadMsg}`]);
        assert.strictEqual(edits[0].body.embeds[0].description, 'Reply two');
        assert.strictEqual(edits[1].body.embeds[0].description, 'Version two');
        assert.deepStrictEqual(edits[1].body.allowed_mentions, { parse: [] });
        assert.strictEqual(hook.messages.get(threadMsg).body.embeds[0].description, 'Version two');
        const keys = deliveries().filter((d) => d.action === 'edit').map((d) => d.dedupe_key);
        assert.ok(keys.includes(`edit:post:${post.id}:mapping:1:r2`) && keys.includes(`edit:thread:${thread.id}:mapping:1:r2`), keys.join());
        // Someone deleted the reply's message on Discord: the next edit finds nothing and says so.
        hook.messages.get(postMsg).deleted = true;
        await forum.editPost(samV, post.id, { body: 'Reply three' });
        await drainAll();
        const last = deliveries().pop();
        assert.deepStrictEqual([last.action, last.status, last.last_error], ['edit', 'skipped', 'the message is gone on Discord']);
        assert.ok(mapOf('post', post.id)[0].external_deleted_at, 'the map knows it is gone');
        const queued = deliveries().length;
        await forum.editPost(samV, post.id, { body: 'Reply four' });
        assert.strictEqual(deliveries().length, queued, 'nothing more is queued for a message that is gone');
        // An edit right before a delete is skipped: only the delete goes out.
        const { post: p2 } = await forum.reply(samV, 'general', thread.slug, { body: 'short-lived' });
        await drainAll();
        hook.hits.length = 0;
        await forum.editPost(samV, p2.id, { body: 'short-lived, edited' });
        await forum.deletePost(samV, p2.id);
        await drainAll();
        assert.deepStrictEqual(hook.hits.map((h) => h.method), ['DELETE']);
        assert.strictEqual(deliveries().find((d) => d.post_id === p2.id && d.action === 'edit').status, 'skipped');
    });

    await check('deletes follow through the map: a reply, and a thread with every reply of it; what was not sent yet is skipped', async () => {
        hook.hits.length = 0;
        const { thread } = await forum.createThread(samV, 'general', { title: 'Delete me', body: 'soon gone' });
        const a = (await forum.reply(samV, 'general', thread.slug, { body: 'a' })).post;
        const b = (await forum.reply(alexV, 'general', thread.slug, { body: 'b' })).post;
        await drainAll();
        const msgs = { thread: mapOf('thread', thread.id)[0].external_message_id, a: mapOf('post', a.id)[0].external_message_id, b: mapOf('post', b.id)[0].external_message_id };
        await forum.deletePost(modV, a.id);   // moderated away
        await drainAll();
        assert.deepStrictEqual(hook.hits.filter((h) => h.method === 'DELETE').map((h) => h.pathname), [`/api/webhooks/1/general/messages/${msgs.a}`]);
        const c = (await forum.reply(samV, 'general', thread.slug, { body: 'c, never sent' })).post;   // queued, not sent yet
        await forum.deleteThread(samV, 'general', thread.slug);
        await drainAll();
        const deleted = hook.hits.filter((h) => h.method === 'DELETE').map((h) => h.pathname).sort();
        assert.deepStrictEqual(deleted, [msgs.thread, msgs.a, msgs.b].map((m) => `/api/webhooks/1/general/messages/${m}`).sort());
        assert.ok(!hook.hits.some((h) => h.method === 'POST' && /c, never sent/.test(JSON.stringify(h.body))), 'the reply queued before the delete never went out');
        assert.deepStrictEqual([deliveries().find((d) => d.post_id === c.id).status], ['skipped']);
        assert.ok(mapOf('thread', thread.id).every((r) => r.external_deleted_at));
        // A delete whose message is already gone on Discord counts as done.
        const t3 = (await forum.createThread(samV, 'general', { title: 'Gone already', body: 'x' })).thread;
        await drainAll();
        hook.messages.get(mapOf('thread', t3.id)[0].external_message_id).deleted = true;
        await forum.deleteThread(samV, 'general', t3.slug);
        await drainAll();
        const del = deliveries().pop();
        assert.deepStrictEqual([del.action, del.status, del.last_status, del.last_error], ['delete', 'delivered', 404, 'the message was already gone on Discord']);
    });

    await check('members-only (VIP): gated threads and spaces never go out, and gating later deletes what went out', async () => {
        hook.hits.length = 0;
        const { thread } = await forum.createThread(samV, 'general', { title: 'Public for now', body: 'x' });
        await forum.reply(alexV, 'general', thread.slug, { body: 'a public reply' });
        await drainAll();
        const posted = hook.hits.length;
        assert.strictEqual(posted, 2);
        await forum.setThreadMembersOnly(samV, 'general', thread.slug, { members_only: sam });
        await drainAll();
        assert.strictEqual(hook.hits.filter((h) => h.method === 'DELETE').length, 2, 'the thread\'s and the reply\'s messages were deleted');
        // Replies in the gated thread (the creator may still post) never go out.
        const gatedThread = db.prepare('SELECT * FROM threads WHERE id = ?').get(thread.id);
        const reply = forumStore.addPost(db, { thread_id: thread.id, author_subject: sam, body_markdown: 'members only' });
        assert.strictEqual(relay.enqueuePost(reply, gatedThread, general), 0);
        // A members-only thread from the start is never queued, nor is anything in a VIP space.
        const gated = newThread(general, 'VIP from the start', { members_only_owner: sam });
        assert.strictEqual(relay.enqueueThread(gated, general), 0);
        db.prepare('UPDATE spaces SET members_only_owner = ? WHERE id = ?').run(sam, feedback.id);
        const vipSpace = forumStore.getSpace(db, 'feedback');
        assert.strictEqual(relay.enqueueThread(newThread(vipSpace, 'In a VIP space'), vipSpace), 0);
        db.prepare('UPDATE spaces SET members_only_owner = NULL WHERE id = ?').run(feedback.id);
        await drainAll();
        assert.ok(!hook.hits.slice(posted).some((h) => h.method !== 'DELETE'), 'nothing but the two deletes');
    });

    await check('an older database: relay_deliveries is rebuilt once, rows kept, the new columns in place', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-relay-migrate-'));
        const file = path.join(dir, 'community.db');
        const old = openDb(file);
        const th = forumStore.createThread(old, { space_id: 1, title: 'Old row', body_markdown: 'x' }).thread;
        old.exec(`DROP TABLE relay_deliveries;
                  CREATE TABLE relay_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
                      mapping_id INTEGER NOT NULL REFERENCES relay_mappings(id) ON DELETE CASCADE, dedupe_key TEXT UNIQUE NOT NULL,
                      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed')), attempts INTEGER NOT NULL DEFAULT 0,
                      next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_status INTEGER, last_error TEXT, delivered_at DATETIME,
                      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (thread_id, mapping_id));
                  CREATE INDEX idx_relay_deliveries_due ON relay_deliveries(status, next_attempt_at);`);
        old.prepare("INSERT INTO relay_mappings (space_id, webhook_url_ref) VALUES (1, 'DISCORD_WEBHOOK_GENERAL')").run();
        old.prepare("INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, status, attempts, last_status) VALUES (?, 1, ?, 'delivered', 1, 204)").run(th.id, `thread:${th.id}:mapping:1`);
        old.close();
        const reopened = openDb(file);
        const cols = reopened.prepare('PRAGMA table_info(relay_deliveries)').all().map((c) => c.name);
        for (const c of ['post_id', 'action', 'source', 'event_id']) assert.ok(cols.includes(c), c);
        const row = reopened.prepare('SELECT * FROM relay_deliveries').get();
        assert.deepStrictEqual([row.thread_id, row.dedupe_key, row.status, row.action, row.source, row.last_status], [th.id, `thread:${th.id}:mapping:1`, 'delivered', 'create', 'direct', 204]);
        reopened.prepare("INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, status) VALUES (?, 1, 'x', 'dropped')").run(th.id);
        assert.ok(reopened.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_relay_deliveries_due'").get());
        const mcols = reopened.prepare('PRAGMA table_info(relay_mappings)').all().map((c) => c.name);
        assert.ok(['discord_channel_id', 'discord_thread_id', 'inbound'].every((c) => mcols.includes(c)));
        reopened.close();
        const again = openDb(file);   // idempotent
        assert.strictEqual(again.prepare('SELECT COUNT(*) AS n FROM relay_deliveries').get().n, 2);
        again.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await check('app wiring: threads, replies, edits and deletes through the API are relayed; the admin endpoints are staff-only and URL-free', async () => {
        const t = await boot({
            authority: 'community',
            appOpts: { relayOptions: { enabled: true, env: { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/9/app` } }, forumLimits: { threads: { cooldownSec: 0 }, posts: { cooldownSec: 0 } } },
        });
        const net = t.network;
        const samU = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
        const samJwt = net.sign({ id: 9, subject_id: samU.subject_id, username: 'sam', role: 'user' });
        const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
        const call = (p, { method = 'GET', cookie, token, json, headers = {} } = {}) => {
            const h = { ...headers };
            if (token) h.authorization = `Bearer ${token}`;
            if (json !== undefined) h['content-type'] = 'application/json';
            return t.get(p, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
        };
        const r = t.app.locals.relay;
        assert.strictEqual(r.status().creates_from, 'forum', 'no EVENTS_URL: the forum queues creates');
        assert.deepStrictEqual([r.status().events_worker.enabled, r.status().inbound.enabled], [false, false]);
        assert.strictEqual((await call('/api/v1/relay/mappings', { method: 'POST', cookie: samJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } })).status, 403);
        const bad = await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'https://discord.com/api/webhooks/secret' } });
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.json().code, 'relay.invalid_ref');
        assert.strictEqual((await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL', discord_channel_id: 'nope' } })).json().code, 'relay.invalid_discord_id');
        const m = await call('/api/v1/relay/mappings', { method: 'POST', cookie: adminJwt, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } });
        assert.strictEqual(m.status, 201, m.text);
        assert.deepStrictEqual([m.json().mapping.space, m.json().mapping.webhook_configured, m.json().mapping.enabled, m.json().mapping.inbound, m.json().mapping.discord_channel_id], ['general', true, true, false, null]);
        const put = await call(`/api/v1/relay/mappings/${m.json().mapping.id}`, { method: 'PUT', cookie: adminJwt, json: { inbound: true, discord_channel_id: '2000000000000000009' } });
        assert.deepStrictEqual([put.json().mapping.inbound, put.json().mapping.discord_channel_id, put.json().mapping.enabled], [true, '2000000000000000009', true]);
        const before = hook.hits.length;
        const waitHits = async (n) => { for (let i = 0; i < 100 && hook.hits.length < n; i++) await new Promise((res) => setTimeout(res, 10)); };
        const th = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Through the app', body: 'hi' } });
        assert.strictEqual(th.status, 201);
        await waitHits(before + 1);
        assert.strictEqual(hook.hits[hook.hits.length - 1].path, '/api/webhooks/9/app?wait=true');
        const reply = await call(`/api/v1/spaces/general/threads/${th.json().thread.slug}/posts`, { method: 'POST', cookie: samJwt, json: { body: 'a reply' } });
        assert.strictEqual(reply.status, 201, reply.text);
        await waitHits(before + 2);
        assert.match(hook.hits[hook.hits.length - 1].body.content, /replied to \*\*Through the app\*\*/);
        assert.strictEqual((await call(`/api/v1/posts/${reply.json().post.id}`, { method: 'PUT', cookie: samJwt, json: { body: 'a reply, edited' } })).status, 200);
        await waitHits(before + 3);
        assert.strictEqual(hook.hits[hook.hits.length - 1].method, 'PATCH');
        assert.strictEqual((await call(`/api/v1/posts/${reply.json().post.id}`, { method: 'DELETE', cookie: samJwt })).status, 200);
        await waitHits(before + 4);
        assert.strictEqual(hook.hits[hook.hits.length - 1].method, 'DELETE');
        hook.plan.push({ status: 400, body: { message: 'Invalid Form Body' } });
        await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'This one fails', body: 'hi' } });
        await waitHits(before + 5);
        await r.drain();
        assert.strictEqual((await call('/api/v1/relay/deliveries')).status, 401);
        assert.strictEqual((await call('/api/v1/relay/deliveries', { cookie: samJwt })).status, 403);
        assert.strictEqual((await call('/api/v1/relay/status', { cookie: samJwt })).status, 403);
        const failed = await call('/api/v1/relay/deliveries?status=failed', { cookie: adminJwt });
        assert.strictEqual(failed.status, 200, failed.text);
        assert.strictEqual(failed.json().enabled, true);
        assert.strictEqual(failed.json().deliveries.length, 1);
        const dl = failed.json().deliveries[0];
        assert.match(dl.last_error, /400: Invalid Form Body/);
        assert.deepStrictEqual([dl.thread.url, dl.action, dl.source], ['/s/general/t/this-one-fails', 'create', 'direct']);
        const edits = await call('/api/v1/relay/deliveries?action=edit', { cookie: adminJwt });
        assert.deepStrictEqual(edits.json().deliveries.map((x) => [x.action, x.status, x.post.id]), [['edit', 'delivered', reply.json().post.id]]);
        const st = await call('/api/v1/relay/status', { cookie: adminJwt });
        assert.strictEqual(st.status, 200);
        assert.deepStrictEqual([st.json().dead_letters, st.json().deliveries.failed, st.json().creates_from], [1, 1, 'forum']);
        assert.strictEqual((await call(`/api/v1/relay/deliveries/${dl.id}/drop`, { method: 'POST', cookie: adminJwt })).status, 200);
        assert.strictEqual((await call(`/api/v1/relay/deliveries/${dl.id}/drop`, { method: 'POST', cookie: adminJwt })).status, 404, 'dropped already');
        assert.strictEqual((await call(`/api/v1/relay/deliveries/${dl.id}/retry`, { method: 'POST', cookie: adminJwt })).status, 200, 'a dropped one can be retried');
        await waitHits(before + 6);
        await r.drain();
        assert.strictEqual((await call('/api/v1/relay/deliveries?status=failed', { cookie: adminJwt })).json().deliveries.length, 0);
        const ready = await call('/api/ready');
        assert.deepStrictEqual([ready.json().discord_relay.enabled, ready.json().discord_relay.events_worker.enabled, ready.json().discord_relay.deliveries.delivered > 0], [true, false, true]);
        const svcAdmin = await call('/api/v1/relay/deliveries', { token: net.signService({ cap: ['community.comment.moderate'] }) });
        assert.strictEqual(svcAdmin.status, 200);
        assert.ok(!(failed.text + svcAdmin.text + st.text + (await call('/api/v1/relay/mappings', { cookie: adminJwt })).text).includes('/api/webhooks/'), 'responses never carry a webhook URL');
        await t.close();
    });

    await check('staff can map only allow-listed webhook variables, never the URL in some other env var', async () => {
        const secretHits = [];
        const internal = { url: 'http://127.0.0.1:9/internal', hits: secretHits };
        const env2 = { DISCORD_WEBHOOK_GENERAL: `${hook.url}/api/webhooks/1/ok`, OV_MEDIA_INTERNAL_URL: internal.url, NETWORK_INTERNAL_URL: internal.url, DISCORD_WEBHOOKS_X: internal.url };
        const fetchSpy = (url, o) => { if (String(url).startsWith(internal.url)) secretHits.push(url); return fetch(url, o); };
        const t = await boot({ authority: 'community', appOpts: { relayOptions: { enabled: true, env: env2, fetchImpl: fetchSpy }, forumLimits: { threads: { cooldownSec: 0 } } } });
        const net = t.network;
        const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', role: 'admin' });
        const samJwt = net.sign({ id: 9, subject_id: net.addUser({ network_user_id: 9, username: 'sam' }).subject_id, username: 'sam', role: 'user' });
        const call = (p, { method = 'GET', cookie, token, json } = {}) => t.get(p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [] });
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
        const gen = t.db.prepare("SELECT id FROM spaces WHERE slug = 'general'").get();
        t.db.prepare("INSERT INTO relay_mappings (space_id, direction, webhook_url_ref, enabled) VALUES (?, 'out', 'OV_MEDIA_INTERNAL_URL', 1)").run(gen.id);
        const listed = (await call('/api/v1/relay/mappings', { cookie: adminJwt })).json().mappings.find((x) => x.webhook_url_ref === 'OV_MEDIA_INTERNAL_URL');
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
        const strict = createDiscordRelay({ db: t.db, env: env2, webhookVars: ['DISCORD_WEBHOOK_GENERAL'] });
        assert.strictEqual(strict.refAllowed('DISCORD_WEBHOOK_GENERAL'), true);
        assert.strictEqual(strict.refAllowed('DISCORD_WEBHOOK_OTHER'), false);
        assert.strictEqual(createDiscordRelay({ db: t.db, env: env2 }).refAllowed('DISCORD_WEBHOOK_OTHER'), true);
    });

    await check('disabled by default in the app: no relay, no Events worker, no gateway, whatever else is set', async () => {
        process.env.DISCORD_BOT_TOKEN = 'not-a-real-token';
        process.env.DISCORD_RELAY_INBOUND = 'on';
        process.env.EVENTS_URL = 'http://127.0.0.1:9';
        try {
            const t = await boot({ authority: 'community' });
            const st = t.app.locals.relay.status();
            assert.deepStrictEqual([st.enabled, st.events_worker.enabled, st.inbound.enabled, t.app.locals.relayInbound], [false, false, false, null]);
            assert.match(st.events_worker.reason, /relay is off/);
            await t.close();
        } finally {
            delete process.env.DISCORD_BOT_TOKEN; delete process.env.DISCORD_RELAY_INBOUND; delete process.env.EVENTS_URL;
        }
    });

    await hook.close();
    done();
})();
