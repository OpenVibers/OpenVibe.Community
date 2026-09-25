'use strict';
/**
 * Categories, feature requests and the Roadmap space (WS-J tasks 1 and 8): seeded categories, filtering
 * by category and status, a request's first status and staff-only status changes, category moves by the
 * author or staff, staff-only roadmap threads, the roadmap sync from docs/roadmap/public.json (create,
 * update in place with the history kept, unchanged, bad items skipped) and the no-JS pages.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { syncRoadmap, syncFromFile } = require('../server/forum/roadmap');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const modJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'global_mod' });
    const call = (path, { method = 'GET', cookie, json, form } = {}) => {
        const h = {};
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };

    await check('seeded: Feedback takes requests with ideas/bugs/questions; Roadmap is public and staff-started', async () => {
        const spaces = (await call('/api/v1/spaces')).json().spaces;
        assert.deepStrictEqual(spaces.map((s) => [s.slug, s.thread_kind]), [['general', 'discussion'], ['feedback', 'request'], ['showcase', 'discussion'], ['roadmap', 'roadmap']]);
        assert.deepStrictEqual(spaces.find((s) => s.slug === 'feedback').statuses, ['open', 'planned', 'in_progress', 'done', 'declined']);
        const cats = (await call('/api/v1/spaces/feedback/categories')).json().categories;
        assert.deepStrictEqual(cats.map((c) => c.slug), ['ideas', 'bugs', 'questions']);
    });

    let req;
    await check('a request starts open, in its category; unknown categories are refused', async () => {
        let r = await call('/api/v1/spaces/feedback/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Dark mode for clips', body: 'Please.', category: 'ideas' } });
        assert.strictEqual(r.status, 201, r.text);
        req = r.json().thread;
        assert.strictEqual(req.kind, 'request'); assert.strictEqual(req.status, 'open');
        assert.deepStrictEqual([req.category.slug, req.category.name], ['ideas', 'Ideas']);
        r = await call('/api/v1/spaces/feedback/threads', { method: 'POST', cookie: samJwt, json: { title: 'Player crashes', body: 'On Safari.', category: 'bugs' } });
        assert.strictEqual(r.status, 201);
        r = await call('/api/v1/spaces/feedback/threads', { method: 'POST', cookie: samJwt, json: { title: 'Nope', body: 'x', category: 'nope' } });
        assert.strictEqual(r.status, 404); assert.strictEqual(r.json().code, 'category.not_found');
        const plain = (await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Just talk', body: 'hi' } })).json().thread;
        assert.strictEqual(plain.kind, 'discussion'); assert.strictEqual(plain.status, null);
    });

    await check('filters: by category and by status; a bad status is 400', async () => {
        let r = (await call('/api/v1/spaces/feedback/threads?category=bugs')).json();
        assert.deepStrictEqual(r.threads.map((x) => x.title), ['Player crashes']);
        assert.strictEqual(r.categories.find((c) => c.slug === 'bugs').thread_count, 1);
        r = (await call('/api/v1/spaces/feedback/threads?status=open')).json();
        assert.strictEqual(r.total, 2);
        assert.strictEqual((await call('/api/v1/spaces/feedback/threads?status=shipped')).status, 400);
        assert.strictEqual((await call('/api/v1/spaces/general/threads?status=open')).status, 400, 'discussions have no status');
    });

    await check('status: staff only, from the kind\'s list', async () => {
        let r = await call(`/api/v1/spaces/feedback/threads/${req.slug}/status`, { method: 'PUT', cookie: alexJwt, json: { status: 'done' } });
        assert.strictEqual(r.status, 403);
        r = await call(`/api/v1/spaces/feedback/threads/${req.slug}/status`, { method: 'PUT', cookie: modJwt, json: { status: 'paused' } });
        assert.strictEqual(r.status, 400, 'paused is a roadmap status');
        r = await call(`/api/v1/spaces/feedback/threads/${req.slug}/status`, { method: 'PUT', cookie: modJwt, json: { status: 'planned' } });
        assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json().thread.status, 'planned');
        assert.deepStrictEqual((await call('/api/v1/spaces/feedback/threads?status=planned')).json().threads.map((x) => x.slug), [req.slug]);
    });

    await check('category: the author or staff move a thread; others cannot; deleting a category keeps its threads', async () => {
        let r = await call(`/api/v1/spaces/feedback/threads/${req.slug}/category`, { method: 'PUT', cookie: samJwt, json: { category: 'bugs' } });
        assert.strictEqual(r.status, 403);
        r = await call(`/api/v1/spaces/feedback/threads/${req.slug}/category`, { method: 'PUT', cookie: alexJwt, json: { category: 'questions' } });
        assert.strictEqual(r.json().thread.category.slug, 'questions');
        r = await call('/api/v1/spaces/feedback/categories/polls', { method: 'PUT', cookie: alexJwt, json: { name: 'Polls' } });
        assert.strictEqual(r.status, 403, 'only staff manage categories');
        r = await call('/api/v1/spaces/feedback/categories/polls', { method: 'PUT', cookie: modJwt, json: { name: 'Polls', position: 9 } });
        assert.strictEqual(r.status, 200, r.text);
        await call(`/api/v1/spaces/feedback/threads/${req.slug}/category`, { method: 'PUT', cookie: modJwt, json: { category: 'polls' } });
        r = await call('/api/v1/spaces/feedback/categories/polls', { method: 'DELETE', cookie: modJwt });
        assert.strictEqual(r.status, 200);
        const thread = (await call(`/api/v1/spaces/feedback/threads/${req.slug}`)).json().thread;
        assert.strictEqual(thread.category, null); assert.strictEqual(thread.status, 'planned');
    });

    await check('roadmap: people cannot start items; staff can', async () => {
        let r = await call('/api/v1/spaces/roadmap/threads', { method: 'POST', cookie: alexJwt, json: { title: 'My idea', body: 'x' } });
        assert.strictEqual(r.status, 403); assert.strictEqual(r.json().code, 'space.staff_threads');
        r = await call('/api/v1/spaces/roadmap/threads', { method: 'POST', cookie: modJwt, json: { title: 'A staff item', body: 'x', category: 'features' } });
        assert.strictEqual(r.status, 201); assert.strictEqual(r.json().thread.status, 'planned');
    });

    await check('roadmap sync: creates, updates in place (history kept), leaves unchanged items alone, skips bad ones', async () => {
        const db = t.db;
        const items = [
            { key: 'chat-calls', category: 'features', status: 'planned', title: 'Calls in Chat', summary: 'Calls move to Chat.' },
            { key: 'bad key!', status: 'planned', title: 'x', summary: 'y' },
            { key: 'nostatus', title: 'No status', summary: 'y' },
        ];
        const quiet = { warn() {} };
        assert.deepStrictEqual(syncRoadmap(db, items, { log: quiet }), { created: 1, updated: 0, unchanged: 0, skipped: 2 });
        let th = (await call('/api/v1/spaces/roadmap/threads?category=features')).json().threads.find((x) => x.title === 'Calls in Chat');
        assert.strictEqual(th.author.display_name, 'OpenVibe'); assert.strictEqual(th.origin, 'system');
        assert.deepStrictEqual(syncRoadmap(db, items.slice(0, 1), { log: quiet }), { created: 0, updated: 0, unchanged: 1, skipped: 0 });
        const next = [{ ...items[0], status: 'in_progress', title: 'Voice and video calls in Chat', summary: 'Calls move to Chat. Started.' }];
        assert.deepStrictEqual(syncRoadmap(db, next, { log: quiet }), { created: 0, updated: 1, unchanged: 0, skipped: 0 });
        const page = (await call(`/api/v1/spaces/roadmap/threads/${th.slug}`)).json();
        assert.strictEqual(page.thread.title, 'Voice and video calls in Chat'); assert.strictEqual(page.thread.status, 'in_progress');
        assert.strictEqual(page.posts[0].body_markdown, 'Calls move to Chat. Started.'); assert.strictEqual(page.posts[0].revision, 2, 'the summary edit keeps the history');
        const file = syncFromFile(db, { log: quiet });
        assert.ok(file && file.created >= 10 && file.skipped === 0, JSON.stringify(file));
        assert.deepStrictEqual(syncFromFile(db, { log: quiet }).updated, 0, 'the shipped file syncs to a fixed point');
    });

    await check('pages: chips, badges, staff forms; no New thread button on the roadmap for people', async () => {
        let r = await call('/s/feedback?category=ideas', { cookie: alexJwt });
        assert.strictEqual(r.status, 200);
        const html = r.text;
        assert.ok(html.includes('aria-label="Categories"') && html.includes('aria-label="Status"') && html.includes('New request'));
        assert.ok(/<meta name="robots" content="noindex,follow"/.test(html), 'filtered lists are not indexed');
        r = await call('/s/roadmap', { cookie: alexJwt });
        assert.ok(!r.text.includes('New roadmap item') && r.text.includes('Staff add roadmap items'));
        assert.ok(r.text.includes('badge-status status-in_progress'));
        r = await call('/s/roadmap/new', { cookie: alexJwt });
        assert.strictEqual(r.status, 403);
        r = await call(`/s/feedback/t/${req.slug}`, { cookie: modJwt });
        assert.ok(r.text.includes('Set status') && r.text.includes('Set category'));
        r = await call(`/s/feedback/t/${req.slug}/status`, { method: 'POST', cookie: modJwt, form: { status: 'done' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual((await call(`/api/v1/spaces/feedback/threads/${req.slug}`)).json().thread.status, 'done');
        r = await call('/s/feedback/new', { cookie: alexJwt });
        assert.ok(r.text.includes('name="category"') && r.text.includes('Search first'));
    });

    await done(t);
})();
