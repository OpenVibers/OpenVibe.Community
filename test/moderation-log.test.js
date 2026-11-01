'use strict';
/**
 * The public moderation log (migrations/0012_forum_moderation_log.sql) and a thread's RSS feed:
 * every moderator action writes one row in the same transaction, in role only (never the actor's
 * subject); the rule is from the allowed list and the reason is trimmed and capped; private spaces
 * keep their log behind the same sign-in rule as the space; a removed thread is shown as one; and
 * the space and thread pages advertise their feeds.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const has = (text, s, msg) => assert.ok(text.includes(s), msg || `expected to find: ${s}`);

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const boss = net.addUser({ network_user_id: 1, username: 'boss', display_name: 'Boss' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const bossJwt = net.sign({ id: 1, subject_id: boss.subject_id, username: 'boss', display_name: 'Boss', role: 'global_mod' });
    const admin = { id: 2, subject_id: ids.newId('user'), username: 'admin', display_name: 'Admin', role: 'admin' };
    const adminJwt = net.sign(admin);

    const call = (path, { method = 'GET', cookie, json } = {}) => t.get(path, {
        method, headers: json !== undefined ? { 'content-type': 'application/json' } : {},
        body: json !== undefined ? JSON.stringify(json) : undefined, cookies: cookie ? [`ov_token=${cookie}`] : [],
    });
    const form = (path, cookie, fields) => t.get(path, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(), cookies: [`ov_token=${cookie}`],
    });
    const rows = async (space = 'general') => t.db.prepare(`SELECT l.* FROM forum_moderation_log l JOIN spaces s ON s.id = l.space_id
        WHERE s.slug = ? ORDER BY l.id ASC`).all(space);
    const thread = async (space, title) => {
        const r = await call(`/api/v1/spaces/${space}/threads`, { method: 'POST', cookie: alexJwt, json: { title, body: `A thread for ${title}` } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().thread;
    };

    let locked;
    let feedback;

    await check('lock, pin, post delete and status each write one log row in role only, with rule and reason', async () => {
        locked = await thread('general', 'A thread that will be moderated');
        const reply = await call(`/api/v1/spaces/general/threads/${locked.slug}/posts`, { method: 'POST', cookie: alexJwt, json: { body: 'A reply that will be removed' } });
        assert.strictEqual(reply.status, 201, reply.text);
        let r = await call(`/api/v1/spaces/general/threads/${locked.slug}/state`, { method: 'PUT', cookie: bossJwt, json: { locked: true, rule: 'spam', reason: '  Repeated   links  ' } });
        assert.strictEqual(r.status, 200, r.text);
        r = await form(`/s/general/t/${locked.slug}/state`, bossJwt, { pinned: '1', rule: 'off-topic', reason: `  Pinned   for ${'x'.repeat(300)}  ` });
        assert.strictEqual(r.status, 303, r.text);
        r = await form(`/s/general/t/${locked.slug}/post/${reply.json().post.id}/delete`, bossJwt, { rule: 'personal information', reason: 'Names someone' });
        assert.strictEqual(r.status, 303, r.text);
        feedback = await thread('feedback', 'A request whose status changes');
        r = await call(`/api/v1/spaces/feedback/threads/${feedback.slug}/status`, { method: 'PUT', cookie: bossJwt, json: { status: 'planned', rule: 'duplicate', reason: 'Already planned elsewhere' } });
        assert.strictEqual(r.status, 200, r.text);

        const generalLog = await rows();
        const feedbackLog = await rows('feedback');
        assert.deepStrictEqual(generalLog.map((x) => x.action), ['lock', 'pin', 'delete']);
        assert.deepStrictEqual(feedbackLog.map((x) => x.action), ['status']);
        assert.deepStrictEqual(generalLog.map((x) => x.rule), ['spam', 'off-topic', 'personal information']);
        assert.strictEqual(feedbackLog[0].rule, 'duplicate');
        assert.strictEqual(generalLog[0].reason, 'Repeated links');
        assert.strictEqual(generalLog[1].reason.length, 280, 'the reason is capped at 280 characters');
        assert.strictEqual(generalLog[1].reason, `Pinned for ${'x'.repeat(280 - 'Pinned for '.length)}`);
        assert.strictEqual(generalLog[2].reason, 'Names someone');
        assert.strictEqual(feedbackLog[0].reason, 'Already planned elsewhere');
        assert.deepStrictEqual([...generalLog, ...feedbackLog].map((x) => x.actor_role), ['staff', 'staff', 'staff', 'staff']);
        assert.strictEqual(generalLog[2].thread_id, locked.id);
        assert.strictEqual(generalLog[2].post_id, reply.json().post.id);
        assert.strictEqual(feedbackLog[0].thread_id, feedback.id);
        const dump = JSON.stringify([...generalLog, ...feedbackLog]);
        assert.ok(!dump.includes(alex.subject_id), "the author's subject is not in the public row");
        assert.ok(!dump.includes(boss.subject_id), "the moderator's subject is not in the public row");
    });

    await check('the rule list is enforced; a no-op change writes nothing', async () => {
        const before = (await rows()).length;
        let r = await call(`/api/v1/spaces/general/threads/${locked.slug}/state`, { method: 'PUT', cookie: bossJwt, json: { locked: false, rule: 'not-a-rule' } });
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json().code, 'moderation.invalid_rule');
        r = await form(`/s/general/t/${locked.slug}/state`, bossJwt, { locked: '1', rule: 'not-a-rule' });
        assert.strictEqual(r.status, 400, r.text);
        has(r.text, 'The rule is one of spam');
        assert.strictEqual((await rows()).length, before, 'a refused rule writes no row');
        r = await call(`/api/v1/spaces/general/threads/${locked.slug}/state`, { method: 'PUT', cookie: bossJwt, json: { locked: true } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await rows()).length, before, 'a lock that changes nothing writes no row');
    });

    await check('the log page and JSON API show what happened, and the space page links it', async () => {
        const page = await t.get('/s/general/log');
        assert.strictEqual(page.status, 200, page.text);
        has(page.text, '<h1>Moderation log</h1>');
        has(page.text, 'A thread that will be moderated');
        has(page.text, 'a post in');
        has(page.text, 'Repeated links');
        has(page.text, 'Staff');
        assert.ok(!page.text.includes(alex.subject_id) && !page.text.includes(boss.subject_id), 'no subject on the page');
        const json = await call('/api/v1/spaces/general/moderation-log');
        assert.strictEqual(json.status, 200, json.text);
        assert.deepStrictEqual(json.json().entries.map((e) => e.action), ['delete', 'pin', 'lock']);
        assert.strictEqual(json.json().space.slug, 'general');
        assert.ok(!json.text.includes(boss.subject_id));
        const feedbackLog = await t.get('/s/feedback/log');
        assert.strictEqual(feedbackLog.status, 200);
        has(feedbackLog.text, 'A request whose status changes');
        has(feedbackLog.text, 'Status changed');
        const space = await t.get('/s/general');
        has(space.text, 'href="/s/general/log"');
        has(space.text, 'Moderation log');
        has(space.text, '<link rel="alternate" type="application/rss+xml"');
    });

    await check('a thread feed is its newest posts, advertised in the thread head and linked on the page', async () => {
        const reply = await call(`/api/v1/spaces/feedback/threads/${feedback.slug}/posts`, { method: 'POST', cookie: alexJwt, json: { body: 'A feed reply with **markup**' } });
        assert.strictEqual(reply.status, 201, reply.text);
        const page = await t.get(`/s/feedback/t/${feedback.slug}`);
        has(page.text, `<link rel="alternate" type="application/rss+xml" title="OpenVibe.Community — A request whose status changes" href="/s/feedback/t/${feedback.slug}/feed.xml">`);
        has(page.text, 'Follow this thread by RSS');
        const feed = await t.get(`/s/feedback/t/${feedback.slug}/feed.xml`);
        assert.strictEqual(feed.status, 200, feed.text);
        assert.match(feed.headers.get('content-type'), /application\/rss\+xml/);
        has(feed.text, 'A request whose status changes');
        has(feed.text, `Re: A request whose status changes`);
        has(feed.text, 'A feed reply with markup');
        const items = feed.text.split('<item>').slice(1);
        has(items[0], 'A feed reply with markup', 'the newest post is the first item');
        has(items[1], 'A request whose status changes');
        const space = await t.get('/s/feedback');
        has(space.text, '<link rel="alternate" type="application/rss+xml"');
        has(space.text, '/s/feedback/feed.xml');
    });

    await check('a private space\'s log is not public; its members and staff read it', async () => {
        await t.db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members')").run();
        const insider = await call('/api/v1/spaces/insiders/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Inside the members space', body: 'Members only' } });
        assert.strictEqual(insider.status, 201, insider.text);
        assert.strictEqual((await call(`/api/v1/spaces/insiders/threads/${insider.json().thread.slug}/state`, { method: 'PUT', cookie: bossJwt, json: { locked: true, rule: 'harassment' } })).status, 200);
        assert.strictEqual((await call('/api/v1/spaces/insiders/moderation-log')).status, 401, 'signed out: no JSON log');
        const anon = await t.get('/s/insiders/log');
        assert.notStrictEqual(anon.status, 200, 'signed out: no page');
        assert.strictEqual((await t.get('/s/insiders/log', { cookies: [`ov_token=${alexJwt}`] })).status, 200, 'a signed-in member reads it');
        assert.strictEqual((await call('/api/v1/spaces/insiders/moderation-log', { cookie: alexJwt })).status, 200);
    });

    await check('a removed thread is shown as "a removed thread"', async () => {
        const r = await call(`/api/v1/spaces/general/threads/${locked.slug}`, { method: 'DELETE', cookie: bossJwt, json: { rule: 'illegal content', reason: 'Removed by a moderator' } });
        assert.strictEqual(r.status, 200, r.text);
        const log = await rows();
        assert.strictEqual(log.at(-1).action, 'delete');
        assert.strictEqual(log.at(-1).rule, 'illegal content');
        const page = await t.get('/s/general/log');
        assert.strictEqual(page.status, 200);
        has(page.text, 'a removed thread');
        has(page.text, 'Removed by a moderator');
        assert.ok(!page.text.includes('A thread that will be moderated'), 'the deleted title is not shown');
        const json = await call('/api/v1/spaces/general/moderation-log');
        assert.strictEqual(json.json().entries[0].action, 'delete');
        assert.strictEqual(json.json().entries[0].thread, null);
    });

    await check('the forms carry the rule select and reason box', async () => {
        const thread2 = await thread('general', 'A thread with moderation controls');
        const reply = await call(`/api/v1/spaces/general/threads/${thread2.slug}/posts`, { method: 'POST', cookie: alexJwt, json: { body: 'A reply with its own delete form' } });
        assert.strictEqual(reply.status, 201, reply.text);
        const page = await t.get(`/s/general/t/${thread2.slug}`, { cookies: [`ov_token=${bossJwt}`] });
        assert.strictEqual(page.status, 200);
        has(page.text, 'Rule applied…');
        has(page.text, 'name="reason"');
        has(page.text, 'maxlength="280"');
        has(page.text, `<form class="mod-form" method="post" action="/s/general/t/${thread2.slug}/state">`);
        has(page.text, `action="/s/general/t/${thread2.slug}/post/${reply.json().post.id}/delete"`);
        has(page.text, 'Delete post');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
