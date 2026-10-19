'use strict';
/**
 * Pinned starter threads (server/forum/starters.js, docs/forum/starters.json): the shipped file gives every forum but
 * the Roadmap one pinned thread by OpenVibe that leads its list; a second sync changes nothing; a changed body is an
 * edit (history kept); staff unpinning or deleting a starter sticks; bad items and unknown spaces are skipped; the
 * bodies link only to OpenVibe sites and same-site paths.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { syncStarters, syncFromFile, FILE } = require('../server/forum/starters');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const modJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'global_mod' });
    const call = (path, { method = 'GET', cookie, json } = {}) => {
        const h = {};
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const quiet = { warn() {} };
    const shipped = require(FILE).items;

    await check('the shipped file: one pinned starter by OpenVibe in each forum but the Roadmap, leading its list', async () => {
        assert.deepStrictEqual(shipped.map((i) => i.space).sort(), ['feedback', 'general', 'help', 'off-topic', 'showcase']);
        // Someone posted first: the starter still leads.
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Hello everyone', body: 'Hi!' } })).status, 201);
        assert.deepStrictEqual(await syncFromFile(t.db, { log: quiet }), { created: 5, updated: 0, unchanged: 0, skipped: 0 });
        for (const item of shipped) {
            const list = (await call(`/api/v1/spaces/${item.space}/threads?sort=new`)).json().threads;
            assert.strictEqual(list[0].title, item.title, item.space);
            assert.ok(list[0].pinned, item.space);
            assert.strictEqual(list[0].origin, 'system');
            assert.strictEqual(list[0].author.display_name, 'OpenVibe');
        }
        assert.deepStrictEqual(await syncFromFile(t.db, { log: quiet }), { created: 0, updated: 0, unchanged: 5, skipped: 0 }, 'a fixed point');
    });

    await check('the page renders the guide with its links (no raw HTML)', async () => {
        const th = (await call('/api/v1/spaces/feedback/threads')).json().threads.find((x) => x.title === 'How feedback works');
        const r = await call(`/s/feedback/t/${th.slug}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('href="/s/roadmap"'), 'same-site link');
        assert.ok(r.text.includes('<strong>One idea or one bug per post.</strong>'));
    });

    await check('bodies link only to OpenVibe sites and same-site paths, and never ask for secrets', async () => {
        for (const item of shipped) {
            for (const [, url] of item.body.matchAll(/\]\(([^)]+)\)/g)) {
                assert.ok(/^\/[a-z]/.test(url) || /^https:\/\/openvibe\.(network|live|tools|games|space|help|community|media|chat)(\/|$)/.test(url), `${item.key}: ${url}`);
            }
        }
        assert.match(shipped.find((i) => i.space === 'help').body, /Never post a password, a stream key, an API token/);
    });

    await check('an edited body is an edit of the opening post; staff unpinning or deleting a starter sticks', async () => {
        const edited = shipped.map((i) => (i.key === 'how-to-get-help' ? { ...i, body: `${i.body}\n\nUpdated.` } : i));
        assert.deepStrictEqual(await syncStarters(t.db, edited, { log: quiet }), { created: 0, updated: 1, unchanged: 4, skipped: 0 });
        const help = (await call('/api/v1/spaces/help/threads')).json().threads[0];
        const page = (await call(`/api/v1/spaces/help/threads/${help.slug}`)).json();
        assert.ok(page.posts[0].body_markdown.endsWith('Updated.'));
        assert.strictEqual(page.posts[0].revision, 2, 'the history stays');

        const welcome = (await call('/api/v1/spaces/general/threads')).json().threads.find((x) => x.title === 'Welcome to OpenVibe: start here');
        const r = await call(`/api/v1/spaces/general/threads/${welcome.slug}/state`, { method: 'PUT', cookie: modJwt, json: { pinned: false } });
        assert.ok(r.status < 300, `unpin answered ${r.status}`);
        await syncStarters(t.db, shipped, { log: quiet });
        const after = (await call(`/api/v1/spaces/general/threads/${welcome.slug}`)).json();
        assert.ok(!after.thread.pinned, 'a sync never re-pins');

        await t.db.prepare("UPDATE threads SET deleted_at = now() WHERE id = ?").run(welcome.id);
        const counts = await syncStarters(t.db, shipped, { log: quiet });
        assert.strictEqual(counts.created, 0, 'a deleted starter is not made again');
    });

    await check('bad items and unknown spaces are skipped', async () => {
        const bad = [{ key: 'Bad Key', space: 'general', title: 'Title', body: 'x' }, { key: 'nowhere', space: 'no-such-space', title: 'Title', body: 'x' }, { key: 'nobody', space: 'general', title: 'Title' }];
        assert.deepStrictEqual(await syncStarters(t.db, bad, { log: quiet }), { created: 0, updated: 0, unchanged: 0, skipped: 3 });
    });

    await done(t);
})();
