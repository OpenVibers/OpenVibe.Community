'use strict';
/**
 * The forum is Community's again (2026-10-08 owner decision): /s and its nested paths serve the
 * forum here. OpenVibe.Space, which briefly held the forum, now hosts code and "spaces" and
 * redirects its forum paths to us; nothing here redirects to Space.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
(async () => {
    const t = await boot();
    await check('GET /s and nested paths serve the forum here, with no redirect to Space', async () => {
        for (const path of ['/s', '/s/general', '/s/general?sort=new']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 200, path);
            assert.strictEqual(r.headers.get('location'), null, path);
        }
        const board = await t.get('/s');
        assert.ok(board.text.includes('Forum · OpenVibe.Community'), 'the board index is Community\'s');
    });
    await check('the boards are called the Forum (openvibe.space is a different product); /forum answers with a 301 to /s', async () => {
        const board = await t.get('/s');
        assert.ok(board.text.includes('<h1>Forum</h1>') && !/<h1>Spaces<\/h1>|>New space<|No spaces yet/.test(board.text), 'the page says Forum');
        const cfg = JSON.parse(board.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.links.find((l) => l.href === '/s').label, 'Forum', 'the nav says Forum');
        assert.ok(!cfg.navbar.links.some((l) => /space/i.test(l.label)), 'no nav link says Spaces');
        for (const [from, to] of [['/forum', '/s'], ['/forum/', '/s'], ['/forum?x=1', '/s?x=1'], ['/forum/general?sort=new', '/s/general?sort=new'], ['/forum/general/t/hello', '/s/general/t/hello']]) {
            const r = await t.get(from, { redirect: 'manual' });
            assert.strictEqual(r.status, 301, from);
            assert.strictEqual(r.headers.get('location'), to, from);
        }
        const nope = await t.get('/forums', { redirect: 'manual' });
        assert.notStrictEqual(nope.status, 301, '/forums is not /forum');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
