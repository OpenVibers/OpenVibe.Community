'use strict';
/** Static-asset Cache-Control comes from openvibe-shared/cache-policy: immutable only for the
 *  ?v= that matches the deployed bytes, a short revalidating window for everything else. */
const assert = require('assert');
const { assetVersion } = require('../server/render/layout');
const cache = require('openvibe-shared/cache-policy');
const { boot, check, done } = require('./helpers/app');

const IMMUTABLE = cache.IMMUTABLE;
const REVALIDATE = cache.assetHeaders('css/community.css', { hashed: false });

(async () => {
    const t = await boot();

    assert.strictEqual(IMMUTABLE, 'public, max-age=31536000, immutable');
    assert.strictEqual(REVALIDATE, 'public, max-age=300, stale-while-revalidate=86400');

    await check('assets: the current ?v= is immutable, a wrong ?v= or none revalidates', async () => {
        const v = assetVersion('css/community.css');
        assert.ok(v && v !== 'dev', 'the asset has a real content hash');

        const hashed = await t.get(`/css/community.css?v=${v}`);
        assert.strictEqual(hashed.status, 200);
        assert.strictEqual(hashed.headers.get('cache-control'), IMMUTABLE);

        // A well-formed but wrong hash must not buy a year of caching.
        const wrong = await t.get('/css/community.css?v=deadbeefdeadbeef');
        assert.strictEqual(wrong.status, 200);
        assert.strictEqual(wrong.headers.get('cache-control'), REVALIDATE);

        const plain = await t.get('/css/community.css');
        assert.strictEqual(plain.status, 200);
        assert.strictEqual(plain.headers.get('cache-control'), REVALIDATE);
    });

    await check('assets: icons and images revalidate instead of being cached forever', async () => {
        for (const rel of ['favicon.svg', 'og-default.png']) {
            const r = await t.get(`/${rel}`);
            assert.strictEqual(r.status, 200, rel);
            assert.strictEqual(r.headers.get('cache-control'), cache.assetHeaders(rel, { hashed: false }), rel);
            assert.strictEqual(r.headers.get('cache-control'), REVALIDATE, rel);
        }
    });

    await check('assets: the page references its assets with the same ?v= that is immutable', async () => {
        const home = await t.get('/');
        let matches = 0;
        for (const m of home.text.matchAll(/\/(css|js)\/([a-z0-9._-]+)\?v=([0-9a-f]{8,10})/g)) {
            matches += 1;
            const rel = `${m[1]}/${m[2]}`;
            const r = await t.get(`/${rel}?v=${m[3]}`);
            assert.strictEqual(r.headers.get('cache-control'), IMMUTABLE, `${rel}?v=${m[3]}`);
        }
        assert.ok(matches > 0, 'page references versioned assets');
    });

    await t.close();
    done();
})();
