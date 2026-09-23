'use strict';
/**
 * Forum rules and /api/v1/spaces + /api/v1/posts: seeded spaces, thread creation (slugs,
 * validation, limits), replies and counters, sorting (hot formula, new, top, pinned first,
 * pagination), votes, edits with versions, deletes, locks, members/staff spaces, service
 * capabilities (community.post.create, community.comment.moderate) and AI authorship.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const forumStore = require('../server/forum/store');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'global_mod' });
    const svc = (cap, extra = {}) => net.signService({ cap, ...extra });
    const POST = 'community.post.create', MOD = 'community.comment.moderate';
    const forum = t.app.locals.forum;
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };

    const call = (path, { method = 'GET', token, cookie, headers = {}, json } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };

    let first;

    await check('seeded spaces: general, feedback, showcase — all public', async () => {
        const r = await call('/api/v1/spaces');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(r.json().spaces.map((s) => [s.slug, s.visibility]), [['general', 'public'], ['feedback', 'public'], ['showcase', 'public']]);
        assert.strictEqual((await call('/api/v1/spaces/nope')).status, 404);
    });

    await check('create thread: author from the JWT, slug from the title (deduplicated), opening post rendered safely', async () => {
        const r = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: '  Hello, World!  ', body: '**hi** <script>alert(1)</script>', author_subject: sam.subject_id } });
        assert.strictEqual(r.status, 201, r.text);
        first = r.json().thread;
        assert.strictEqual(first.slug, 'hello-world');
        assert.strictEqual(first.title, 'Hello, World!');
        assert.strictEqual(first.url, '/s/general/t/hello-world');
        assert.strictEqual(first.author.subject, alex.subject_id);
        const op = r.json().post;
        assert.strictEqual(op.is_opening, true);
        assert.strictEqual(op.body_html, '<p><strong>hi</strong> &lt;script&gt;alert(1)&lt;/script&gt;</p>');
        const again = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Hello world', body: 'dup title' } });
        assert.strictEqual(again.json().thread.slug, 'hello-world-2');
        const elsewhere = await call('/api/v1/spaces/feedback/threads', { method: 'POST', cookie: samJwt, json: { title: 'Hello world!', body: 'other space' } });
        assert.strictEqual(elsewhere.json().thread.slug, 'hello-world', 'slugs are unique per space');
        assert.strictEqual(forumStore.slugify('Ünïcödé — ☃ !!'), 'unicode');
        assert.strictEqual(forumStore.slugify('☃☃☃'), 'thread');
    });

    await check('create thread: validation and who may post', async () => {
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', json: { title: 'Anon', body: 'x' } })).status, 401);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'ab', body: 'x' } })).json().code, 'thread.invalid_title');
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Fine title', body: '   ' } })).json().code, 'post.empty');
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Fine title', body: 'x'.repeat(40_001) } })).json().code, 'post.too_long');
        const noCap = await call('/api/v1/spaces/general/threads', { method: 'POST', token: svc(['community.comment.write']), headers: { 'x-ov-subject': alex.subject_id }, json: { title: 'Via service', body: 'x' } });
        assert.strictEqual(noCap.status, 403);
        const noSubject = await call('/api/v1/spaces/general/threads', { method: 'POST', token: svc([POST]), json: { title: 'Via service', body: 'x' } });
        assert.strictEqual(noSubject.status, 401, 'a service names the person or says it is AI');
        const ok = await call('/api/v1/spaces/general/threads', { method: 'POST', token: svc([POST]), headers: { 'x-ov-subject': sam.subject_id }, json: { title: 'Via service', body: 'as sam' } });
        assert.strictEqual(ok.status, 201, ok.text);
        assert.strictEqual(ok.json().thread.author.username, 'sam');
    });

    await check('AI threads: origin ai, no author subject, labelled', async () => {
        const r = await call('/api/v1/spaces/showcase/threads', { method: 'POST', token: svc([POST]), headers: { 'x-ov-origin': 'ai', 'x-ov-subject': alex.subject_id }, json: { title: 'Stream highlights', body: 'AI summary' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().thread.origin, 'ai');
        assert.strictEqual(r.json().thread.author.is_ai, true);
        assert.strictEqual(r.json().thread.author.subject, null);
        assert.strictEqual(t.db.prepare('SELECT author_subject FROM threads WHERE id = ?').get(r.json().thread.id).author_subject, null);
    });

    await check('replies: reply_count and last activity move; locked threads refuse people, not moderators', async () => {
        const r1 = await call('/api/v1/spaces/general/threads/hello-world/posts', { method: 'POST', cookie: samJwt, json: { body: 'first reply' } });
        assert.strictEqual(r1.status, 201, r1.text);
        assert.match(r1.json().url, /^\/s\/general\/t\/hello-world#post-\d+$/);
        await call('/api/v1/spaces/general/threads/hello-world/posts', { method: 'POST', cookie: alexJwt, json: { body: 'second reply' } });
        const th = (await call('/api/v1/spaces/general/threads/hello-world')).json();
        assert.strictEqual(th.thread.reply_count, 2);
        assert.deepStrictEqual(th.posts.map((p) => p.body_markdown), ['**hi** <script>alert(1)</script>', 'first reply', 'second reply']);
        assert.strictEqual((await call('/api/v1/spaces/general/threads/hello-world/state', { method: 'PUT', cookie: samJwt, json: { locked: true } })).status, 403);
        const lock = await call('/api/v1/spaces/general/threads/hello-world/state', { method: 'PUT', cookie: adminJwt, json: { locked: true } });
        assert.strictEqual(lock.status, 200, lock.text);
        assert.strictEqual(lock.json().thread.locked, true);
        const refused = await call('/api/v1/spaces/general/threads/hello-world/posts', { method: 'POST', cookie: samJwt, json: { body: 'let me in' } });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.json().code, 'thread.locked');
        assert.strictEqual((await call('/api/v1/spaces/general/threads/hello-world/posts', { method: 'POST', cookie: adminJwt, json: { body: 'mod note' } })).status, 201);
        assert.strictEqual((await call('/api/v1/spaces/general/threads/hello-world/votes', { method: 'POST', cookie: samJwt, json: { value: 1 } })).status, 403);
        const svcUnlock = await call('/api/v1/spaces/general/threads/hello-world/state', { method: 'PUT', token: svc([MOD]), json: { locked: false } });
        assert.strictEqual(svcUnlock.status, 200, 'a moderating service acting as itself');
        assert.strictEqual((await call('/api/v1/spaces/general/threads/hello-world/state', { method: 'PUT', token: svc([POST]), json: { locked: false } })).status, 403);
    });

    await check('edits keep versions; only the author or a moderator edits', async () => {
        const th = (await call('/api/v1/spaces/general/threads/hello-world')).json();
        const reply = th.posts.find((p) => p.body_markdown === 'first reply');
        assert.strictEqual((await call(`/api/v1/posts/${reply.id}`, { method: 'PUT', cookie: alexJwt, json: { body: 'hijack' } })).status, 403);
        const e1 = await call(`/api/v1/posts/${reply.id}`, { method: 'PUT', cookie: samJwt, json: { body: 'first reply (edited)' } });
        assert.strictEqual(e1.status, 200, e1.text);
        assert.strictEqual(e1.json().post.revision, 2);
        await call(`/api/v1/posts/${reply.id}`, { method: 'PUT', cookie: adminJwt, json: { body: 'moderated' } });
        const v = await call(`/api/v1/posts/${reply.id}/versions`, { cookie: samJwt });
        assert.deepStrictEqual(v.json().versions.map((x) => [x.revision, x.body_markdown]), [[1, 'first reply'], [2, 'first reply (edited)'], [3, 'moderated']]);
        assert.strictEqual((await call(`/api/v1/posts/${reply.id}/versions`, { cookie: alexJwt })).status, 403);
    });

    await check('votes on threads: add/change/remove, score recomputed, my_vote shown', async () => {
        const vote = (value, cookie) => call('/api/v1/spaces/general/threads/hello-world/votes', { method: 'POST', cookie, json: { value } });
        assert.strictEqual((await vote(1, samJwt)).json().score, 1);
        assert.strictEqual((await vote(1, alexJwt)).json().score, 2);
        assert.strictEqual((await vote(-1, samJwt)).json().score, 0);
        assert.strictEqual((await vote(0, samJwt)).json().score, 1);
        assert.strictEqual((await vote(1)).status, 401);
        assert.strictEqual((await vote('x', samJwt)).status, 400);
        assert.strictEqual((await call('/api/v1/spaces/general/threads/hello-world', { cookie: alexJwt })).json().thread.my_vote, 1);
    });

    await check('sorting: new, top, hot (deterministic formula at a fixed now), pinned first, pagination', async () => {
        const space = forumStore.getSpace(t.db, 'showcase');
        const mk = (title, score, hoursAgo) => {
            const { thread } = forumStore.createThread(t.db, { space_id: space.id, title, author_subject: alex.subject_id, body_markdown: 'x' });
            t.db.prepare("UPDATE threads SET score = ?, created_at = datetime('2026-09-22 12:00:00', ?), last_activity_at = datetime('2026-09-22 12:00:00', ?) WHERE id = ?")
                .run(score, `-${hoursAgo} hours`, `-${hoursAgo} hours`, thread.id);
            return thread;
        };
        t.db.prepare('DELETE FROM threads WHERE space_id = ?').run(space.id);
        mk('old popular', 50, 48);     // (51)/(50^1.5) ≈ 0.144
        mk('fresh quiet', 0, 1);       // (1)/(3^1.5)   ≈ 0.192
        mk('fresh liked', 5, 2);       // (6)/(4^1.5)   = 0.75
        mk('ancient', 3, 500);
        const now = new Date('2026-09-22T12:00:00Z');
        const titles = async (sort, extra = {}) => (await forum.listThreads(asAlex, 'showcase', { sort, now, ...extra })).threads.map((x) => x.title);
        assert.deepStrictEqual(await titles('hot'), ['fresh liked', 'fresh quiet', 'old popular', 'ancient']);
        assert.deepStrictEqual(await titles('hot'), await titles('hot'), 'same inputs, same order');
        assert.deepStrictEqual(await titles('new'), ['fresh quiet', 'fresh liked', 'old popular', 'ancient']);
        assert.deepStrictEqual(await titles('top'), ['old popular', 'fresh liked', 'ancient', 'fresh quiet']);
        const ancient = t.db.prepare("SELECT id FROM threads WHERE title = 'ancient'").get().id;
        t.db.prepare('UPDATE threads SET pinned = 1 WHERE id = ?').run(ancient);
        assert.strictEqual((await titles('hot'))[0], 'ancient');
        const p1 = await forum.listThreads(asAlex, 'showcase', { sort: 'new', now, limit: 3 });
        const p2 = await forum.listThreads(asAlex, 'showcase', { sort: 'new', now, limit: 3, page: 2 });
        assert.deepStrictEqual([p1.pages, p1.total, p1.threads.length, p2.threads.length], [2, 4, 3, 1]);
        const hot = t.db.prepare('SELECT ov_hot(5, 2) AS h').get().h;
        assert.ok(Math.abs(hot - 6 / Math.pow(4, 1.5)) < 1e-12, 'ov_hot = (score + 1) / (hours + 2)^1.5');
    });

    await check('deletes: author or moderator; opening post deletes the thread; tombstones keep numbering', async () => {
        const th = (await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Delete me later', body: 'op' } })).json().thread;
        const reply = (await call(`/api/v1/spaces/general/threads/${th.slug}/posts`, { method: 'POST', cookie: alexJwt, json: { body: 'a reply' } })).json().post;
        await call(`/api/v1/spaces/general/threads/${th.slug}/posts`, { method: 'POST', cookie: samJwt, json: { body: 'another' } });
        assert.strictEqual((await call(`/api/v1/posts/${reply.id}`, { method: 'DELETE', cookie: samJwt })).status, 403);
        assert.strictEqual((await call(`/api/v1/posts/${reply.id}`, { method: 'DELETE', cookie: alexJwt })).status, 200);
        const after = (await call(`/api/v1/spaces/general/threads/${th.slug}`)).json();
        assert.strictEqual(after.thread.reply_count, 1);
        assert.deepStrictEqual(after.posts.map((p) => p.deleted), [false, true, false]);
        assert.strictEqual(after.posts[1].body_markdown, null);
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${th.slug}`, { method: 'DELETE', cookie: alexJwt })).status, 403);
        const op = after.posts[0];
        assert.strictEqual((await call(`/api/v1/posts/${op.id}`, { method: 'DELETE', cookie: samJwt })).json().deleted, 'thread');
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${th.slug}`)).status, 404);
        const other = (await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Moderated away', body: 'x' } })).json().thread;
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${other.slug}`, { method: 'DELETE', cookie: adminJwt })).status, 200);
    });

    await check('members and staff spaces: sign-in for members, invisible for non-staff', async () => {
        t.db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members'), ('mods', 'Mods', 'staff')").run();
        assert.strictEqual((await call('/api/v1/spaces/insiders/threads')).status, 401);
        assert.strictEqual((await call('/api/v1/spaces/insiders/threads', { cookie: samJwt })).status, 200);
        assert.strictEqual((await call('/api/v1/spaces/mods/threads', { cookie: samJwt })).status, 404);
        assert.strictEqual((await call('/api/v1/spaces/mods/threads', { cookie: adminJwt })).status, 200);
        const listed = (await call('/api/v1/spaces', { cookie: samJwt })).json().spaces.map((s) => s.slug);
        assert.ok(listed.includes('insiders') && !listed.includes('mods'));
        assert.ok(!(await call('/api/v1/spaces')).json().spaces.some((s) => s.slug === 'insiders'));
        assert.strictEqual((await call('/api/v1/spaces/mods/threads', { method: 'POST', cookie: samJwt, json: { title: 'Sneaky', body: 'x' } })).status, 404);
        assert.strictEqual((await call('/api/v1/spaces/mods/threads', { method: 'POST', cookie: adminJwt, json: { title: 'Mod talk', body: 'x' } })).status, 201);
    });

    await check('person limits: thread cooldown and daily cap, reply duplicates', async () => {
        const { createForumService } = require('../server/forum/service');
        const strict = createForumService({ db: t.db, limits: { threadsPerDay: 2, threads: { cooldownSec: 30 } } });
        const who = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
        await strict.createThread(who, 'general', { title: 'One thread', body: 'x' });
        await assert.rejects(strict.createThread(who, 'general', { title: 'Two thread', body: 'y' }), (e) => e.status === 429 && e.code === 'request.rate_limited');
        const daily = createForumService({ db: t.db, limits: { threadsPerDay: 2, threads: { cooldownSec: 0 }, posts: { cooldownSec: 0 } } });
        await daily.createThread(who, 'general', { title: 'Second thread', body: 'x' });
        await assert.rejects(daily.createThread(who, 'general', { title: 'Third thread', body: 'x' }), (e) => e.status === 429 && /Daily/.test(e.message));
        await daily.reply(who, 'general', 'second-thread', { body: 'same words' });
        await assert.rejects(daily.reply(who, 'general', 'second-thread', { body: 'same words' }), (e) => e.code === 'request.duplicate');
    });

    await t.close();
    done();
})();
