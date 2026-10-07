'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
(async () => {
    const t = await boot();
    await check('GET /s and nested paths redirect permanently to Space with query intact', async () => {
        for (const path of ['/s', '/s?sort=new', '/s/foo/t/123?x=1&y=two']) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 301, path);
            assert.strictEqual(r.headers.get('location'), `https://openvibe.space${path}`);
        }
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
