'use strict';
// People's pastes and the moment pastes from streams, apart (plan 10-22: 890 AI pastes beside 307 by people buried what
// people wrote). The home's latest and most viewed are people's, with a "From streams" shelf of its own; /pastes lists
// people's by default, from=streams the AI ones and from=all both; the store's 'people' is every origin but AI.
const assert = require('assert');
const source = require('../server/pastes/source');
const catalog = require('../server/pastes/catalog');
const pages = require('../server/render/pages');

const at = (i) => new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
const rows = [
    // The moment pastes are screenshots with a caption, as in production (892 of 892 on 2026-10-22).
    { slug: 'ai-1', origin: 'ai', type: 'screenshot', title: 'Moment one', visibility: 'public', views: 500, created_at: at(30) },
    { slug: 'ai-2', origin: 'ai', type: 'screenshot', title: 'Moment two', visibility: 'public', views: 400, created_at: at(31) },
    { slug: 'me-1', origin: 'user', type: 'paste', title: 'My script', visibility: 'public', views: 5, created_at: at(10) },
    { slug: 'imp-1', origin: 'imported', type: 'paste', title: 'Imported log', visibility: 'public', views: 9, created_at: at(11) },
].sort((a, b) => b.created_at.localeCompare(a.created_at));
const asked = [];
source.use({
    list: async (_viewer, q) => {
        asked.push(q.origin || 'any');
        const keep = (p) => (!q.type || p.type === q.type) && (!q.origin || (q.origin === 'people' ? p.origin !== 'ai' : p.origin === q.origin));
        const found = rows.filter(keep);
        return { pastes: found.slice(q.offset || 0, (q.offset || 0) + q.limit), total: found.length };
    },
});

let passed = 0;
const check = async (name, fn) => { catalog.reset(); await fn(); passed++; console.log('  ✓', name); };

(async () => {
    await check('latest and most viewed by people leave AI pastes out; from streams is only them; all is everything', async () => {
        assert.deepStrictEqual((await catalog.latest(12, { from: 'people' })).map((p) => p.slug), ['imp-1', 'me-1']);
        assert.deepStrictEqual((await catalog.trending(8, { from: 'people' })).map((p) => p.slug), ['imp-1', 'me-1']);
        assert.deepStrictEqual((await catalog.latest(8, { from: 'streams' })).map((p) => p.slug), ['ai-2', 'ai-1']);
        assert.strictEqual((await catalog.latest(12)).length, 4, 'the default (the sitemap and feeds) is every public paste');
        assert.deepStrictEqual((await catalog.latest(3, { from: 'nonsense' })).length, 3, 'an unknown origin is everything');
    });

    await check('/pastes lists people\'s by default, and from=streams or from=all on request, in the store and the window', async () => {
        const people = await catalog.browse({});
        assert.deepStrictEqual([people.from, people.pastes.map((p) => p.slug)], ['people', ['imp-1', 'me-1']]);
        const streams = await catalog.browse({ from: 'streams' });
        assert.deepStrictEqual([streams.type, streams.pastes.map((p) => p.slug)], ['all', ['ai-2', 'ai-1']], 'from streams lists every type: the moments are screenshots');
        assert.strictEqual((await catalog.browse({ from: 'all', type: 'all' })).total, 4);
        assert.deepStrictEqual((await catalog.browse({ from: 'streams', sort: 'views' })).pastes.map((p) => p.slug), ['ai-1', 'ai-2'], 'the windowed path keeps the origin too');
        assert.ok(asked.includes('people') && asked.includes('ai'));
    });

    await check('the home has a From streams shelf; the browse page says whose pastes and keeps it in its links', async () => {
        const home = pages.homePage({ latest: [], fromStreams: [rows[0]], languages: [] });
        assert.match(home, /id="from-streams"/);
        assert.match(home, /href="\/pastes\?from=streams"/);
        assert.doesNotMatch(pages.homePage({ latest: [], languages: [] }), /id="from-streams"/, 'no shelf without any');
        const out = await catalog.browse({ from: 'streams' });
        const page = pages.browsePage({ ...out, pages: 3 }, []);
        assert.match(page, /from streams, written up by OpenVibe\.AI/);
        assert.match(page, /<option value="streams" selected>/);
        assert.match(page, /href="\/pastes\?type=all&amp;from=streams&amp;page=2"/, 'the pager keeps whose pastes');
        assert.match(pages.browsePage({ ...(await catalog.browse({})), pages: 1 }, []), /pastes by people/);
    });

    console.log(`pastes from streams: ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
