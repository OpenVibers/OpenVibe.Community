'use strict';
// The paste catalog's windows: text pastes and images each get their own latest window, so a run of screenshots never
// hides every text paste from "most viewed", the language list or related pastes (production 2026-10-14: the latest 200
// public pastes were all screenshots and "most viewed" said "0 pastes in the latest 200" beside 59 on the newest page).
const assert = require('assert');
const source = require('../server/pastes/source');
const catalog = require('../server/pastes/catalog');

const at = (i) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
const shots = Array.from({ length: 200 }, (_, i) => ({ slug: `shot-${i}`, type: 'screenshot', visibility: 'public', views: i, created_at: at(1000 + i) }));
const text = [
    { slug: 'bash-1', type: 'paste', language: 'bash', visibility: 'public', views: 76, created_at: at(10) },
    { slug: 'js-1', type: 'paste', language: 'javascript', visibility: 'public', views: 12, created_at: at(11) },
    { slug: 'txt-1', type: 'paste', language: 'text', visibility: 'public', views: 60, created_at: at(12) },
    { slug: 'bash-2', type: 'paste', language: 'bash', visibility: 'public', views: 3, created_at: at(13) },
    { slug: 'secret', type: 'paste', language: 'bash', visibility: 'unlisted', views: 999, created_at: at(14) },
];
// The newest and most viewed image is someone's profile picture, public by Live's avatar upload default.
shots[199].metadata = JSON.stringify({ kind: 'avatar', mime_type: 'image/png' });
const all = [...shots, ...text].sort((a, b) => b.created_at.localeCompare(a.created_at));
const asked = [];
source.use({
    list: async (_viewer, q) => {
        asked.push(q.type || 'any');
        const rows = all.filter((p) => !q.type || p.type === q.type);
        return { pastes: rows.slice(q.offset || 0, (q.offset || 0) + q.limit), total: rows.length };
    },
});

let passed = 0;
const check = async (name, fn) => { catalog.reset(); await fn(); passed++; console.log('  ✓', name); };

(async () => {
    await check('most viewed lists the text pastes even when images fill the latest 200', async () => {
        const r = await catalog.browse({ sort: 'views' });
        assert.deepStrictEqual(r.pastes.map((p) => p.slug), ['bash-1', 'txt-1', 'js-1', 'bash-2'], 'public text pastes by views; never an unlisted one');
        assert.strictEqual(r.total, 4);
    });
    await check('a language filter finds its pastes; images and all have their own windows', async () => {
        assert.deepStrictEqual((await catalog.browse({ lang: 'bash' })).pastes.map((p) => p.slug), ['bash-2', 'bash-1']);
        const images = await catalog.browse({ type: 'images', sort: 'views' });
        assert.strictEqual(images.pastes[0].slug, 'shot-199');
        assert.strictEqual(images.total, 200);
        const both = await catalog.browse({ type: 'all', sort: 'views' });
        assert.strictEqual(both.total, 204);
        assert.strictEqual(both.pastes[0].slug, 'shot-199', 'all, by views: the most viewed of either kind');
        assert.deepStrictEqual((await catalog.browse({ type: 'all', lang: 'bash' })).pastes.map((p) => p.slug), ['bash-2', 'bash-1'], 'and the text pastes are in it');
    });
    await check('the language list counts the text pastes beside the images', async () => {
        const langs = Object.fromEntries((await catalog.languages()).map((l) => [l.language, l.count]));
        assert.deepStrictEqual(langs, { image: 200, bash: 2, javascript: 1, text: 1 });
    });
    await check('related pastes of a text paste are text pastes, its own language first', async () => {
        const rel = await catalog.related(text[0], 3);
        assert.deepStrictEqual(rel.map((p) => p.slug), ['bash-2', 'txt-1', 'js-1'], 'its language first, then the newest');
        assert.ok(asked.includes('paste'), 'asked the store for text pastes, not the shared window');
    });
    await check('the home\'s latest and most viewed leave profile pictures out; the lists keep them', async () => {
        assert.strictEqual((await catalog.latest(3))[0].slug, 'shot-198', 'latest: the avatar is skipped');
        assert.strictEqual((await catalog.trending(3))[0].slug, 'shot-198', 'most viewed: the avatar is skipped');
        assert.strictEqual((await catalog.browse({ type: 'images', sort: 'views' })).pastes[0].slug, 'shot-199', 'the image list still has it');
    });
    await check('the home\'s latest and most viewed leave a rough title out (openvibe-sdk/front-page); the lists keep it', async () => {
        shots[198].title = 'this is bullshit';
        assert.strictEqual((await catalog.latest(3))[0].slug, 'shot-197', 'latest: the next one shows');
        assert.strictEqual((await catalog.trending(3))[0].slug, 'shot-197', 'most viewed: the next one shows');
        assert.strictEqual((await catalog.browse({ type: 'images', sort: 'views' })).pastes[1].slug, 'shot-198', 'the image list keeps it');
        delete shots[198].title;
    });
    console.log(`paste catalog: ${passed} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
