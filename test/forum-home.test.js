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
        assert.ok(board.text.includes('Spaces · OpenVibe.Community'), 'the board index is Community\'s');
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
