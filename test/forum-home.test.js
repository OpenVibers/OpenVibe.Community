'use strict';
/**
 * The forum is Community's (2026-10-08 owner decision) and moved from /s to /forum (2026-11-07):
 * /forum and its nested paths serve it, and every old /s address answers a permanent redirect
 * (301 for reads, 308 for form posts) with the query string kept. Nothing here redirects to Space.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
(async () => {
    const t = await boot();
    await check('GET /forum and nested paths serve the forum here, with no redirect to Space', async () => {
        for (const path of ['/forum', '/forum/general', '/forum/general?sort=new']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, path);
            assert.strictEqual(r.headers.get('location'), null, path);
        }
        const board = await t.get('/forum');
        assert.ok(board.text.includes('Forum · OpenVibe.Community'), 'the board index is Community\'s');
    });
    await check('the boards are called the Forum; the nav and canonical use /forum', async () => {
        const board = await t.get('/forum');
        assert.ok(board.text.includes('<h1>Forum</h1>') && !/<h1>Spaces<\/h1>|>New space<|No spaces yet/.test(board.text), 'the page says Forum');
        assert.ok(board.text.includes('<link rel="canonical" href="https://openvibe.community/forum">'), 'canonical is /forum');
        const cfg = JSON.parse(board.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.links.find((l) => l.href === '/forum').label, 'Forum', 'the nav says Forum');
        assert.ok(!cfg.navbar.links.some((l) => /space/i.test(l.label)), 'no nav link says Spaces');
    });
    await check('every old /s address answers a 301 to its /forum address, query kept', async () => {
        const map = [
            ['/s', '/forum'],
            ['/s/', '/forum'],
            ['/s?x=1', '/forum?x=1'],
            ['/s/general', '/forum/general'],
            ['/s/general?sort=new', '/forum/general?sort=new'],
            ['/s/general/t/hello', '/forum/general/hello'],
            ['/s/general/t/hello?page=2', '/forum/general/hello?page=2'],
            ['/s/general/t/hello/feed.xml', '/forum/general/hello/feed.xml'],
            ['/s/general/new', '/forum/general/new'],
            ['/s/general/log', '/forum/general/log'],
            ['/s/general/feed.xml', '/forum/general/feed.xml'],
            ['/s/feed.xml', '/forum/feed.xml'],
            ['/s/new-space', '/forum/new'],
            ['/s/discuss', '/forum/discuss'],
        ];
        for (const [from, to] of map) {
            const r = await t.get(from, { redirect: 'manual' });
            assert.strictEqual(r.status, 301, from);
            assert.strictEqual(r.headers.get('location'), to, from);
        }
        const nope = await t.get('/forums', { redirect: 'manual' });
        assert.notStrictEqual(nope.status, 301, '/forums is not the forum');
    });
    await check('an old form post answers a 308 to the /forum address, method and body kept', async () => {
        const r = await t.get('/s/general/t/hello/reply', {
            method: 'POST', redirect: 'manual',
            body: new URLSearchParams({ body: 'old tab' }).toString(),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        assert.strictEqual(r.status, 308);
        assert.strictEqual(r.headers.get('location'), '/forum/general/hello/reply');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
