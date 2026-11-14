'use strict';
/**
 * Pulse reads Network's one feed (feed.item@1): GET /api/v1/feed and /api/v1/pulse are the proxy, the
 * same ids as the menu; GET /api/v1/activity is Community's own public rows for Network's collector;
 * /feed renders those cards, and /pulse mounts the shared feed (test/pulse.test.js). No Pulse store is read
 * or written.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const ITEM = {
    id: 'f:community:thread:1', kind: 'post', url: 'https://openvibe.community/forum/status/hello',
    title: 'Hello from the one feed', text: 'one line', at: new Date().toISOString(), site: 'community', site_name: 'Community',
    actor: { name: 'Alex', avatar: null }, subject: 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W', media: null, counts: { likes: 2 },
};

(async () => {
    const asked = [];
    const feedFetch = async (url, opts = {}) => {
        const u = new URL(String(url));
        asked.push({ path: u.pathname, query: u.searchParams, auth: opts.headers && opts.headers.Authorization });
        const body = u.pathname === '/api/v1/feed/examples' ? { examples: [{ text: 'new photos', reason: 'kind' }] }
            : u.pathname === '/api/v1/feed/wall' ? { items: [{ ...ITEM, source: { service: 'community', type: 'thread', id: '1' }, origin: 'user', occurred_at: ITEM.at }], next_cursor: null }
                : { items: [ITEM], next_cursor: 'next' };
        return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    };
    const t = await boot({ authority: 'community', appOpts: { feedFetch, startRelay: false, startSharingWorker: false } });

    await check('GET /api/v1/feed is Network\'s feed, filters and the person\'s token passed through', async () => {
        const r = await t.get('/api/v1/feed?kind=clip&limit=20', { headers: { authorization: 'Bearer user-token-123456' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().items[0].id, ITEM.id);
        const last = asked[asked.length - 1];
        assert.deepStrictEqual([last.path, last.query.get('kind'), last.query.get('limit')], ['/api/v1/feed', 'clip', '20']);
        assert.strictEqual(last.auth, 'Bearer user-token-123456');
        assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
        const anon = await t.get('/api/v1/feed');
        assert.strictEqual(anon.headers.get('cache-control'), 'public, max-age=30');
    });

    await check('GET /api/v1/feed/wall and the old /api/v1/pulse return the same rows and ids', async () => {
        const wall = await t.get('/api/v1/feed/wall?limit=5');
        const pulse = await t.get('/api/v1/pulse?limit=5&after=cursor-1');
        assert.strictEqual(wall.json().items[0].id, pulse.json().items[0].id);
        const last = asked[asked.length - 1];
        assert.deepStrictEqual([last.path, last.query.get('cursor')], ['/api/v1/feed/wall', 'cursor-1']);
    });

    await check('the /feed page draws the feed cards and its examples', async () => {
        const r = await t.get('/feed?kind=post');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Hello from the one feed/);
        assert.match(r.text, /new photos/);
    });

    await check('GET /api/v1/activity is Community\'s public rows only', async () => {
        const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, created_at)
            VALUES (?, ?, 'user', 'paste', ?, ?, ?, ?)`).run('public-one', ITEM.subject, 'A public paste', 'hello', 'public', at);
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, created_at)
            VALUES (?, ?, 'user', 'paste', ?, ?, ?, ?)`).run('private-one', ITEM.subject, 'A private paste', 'secret', 'private', at);
        const space = await t.db.prepare("SELECT id FROM spaces WHERE slug = 'general'").get();
        await t.db.prepare(`INSERT INTO threads (space_id, slug, title, author_subject, origin, created_at)
            VALUES (?, 'one-feed', 'A thread about one feed', ?, 'user', ?)`).run(space.id, ITEM.subject, at);
        const r = await t.get('/api/v1/activity?limit=50');
        assert.strictEqual(r.status, 200, r.text);
        const items = r.json().items;
        assert.ok(items.some((i) => i.id === 'public-one' && i.url === 'https://openvibe.community/p/public-one'));
        assert.ok(items.some((i) => i.title === 'A thread about one feed' && i.url === 'https://openvibe.community/forum/general/one-feed'), 'a thread links to its own slug');
        assert.ok(!items.some((i) => i.id === 'private-one'), 'a private paste never leaves Community');
        assert.ok(items.every((i) => i.service === 'community' && i.at && i.url));
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
