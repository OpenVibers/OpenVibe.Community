'use strict';
/**
 * /pulse is the shared feed: the same component the menu's Feed tab draws (openvibe-shared/ov-home.js,
 * OpenVibeHome.feed), on the same Network feed. The page answers 200, names the mount, loads ov-home.js from
 * this site's own pinned copy, and renders the first page of that same feed for the crawlers. When Network
 * does not answer, the page still answers and says the feed is loading.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const { pulsePage } = require('../server/render/pulse');
const { createFeedProxy } = require('../server/feed/proxy');

const ITEM = {
    id: 'f:community:post:1', kind: 'post', url: 'https://openvibe.community/forum/general/hello',
    title: 'Hello from the one feed', text: 'one line', at: new Date().toISOString(),
    site: 'community', site_name: 'Community', actor: null, subject: null, media: null, counts: {},
};

(async () => {
    const feedFetch = async (url) => {
        const u = new URL(String(url));
        const body = u.pathname === '/api/v1/feed/examples' ? { examples: [{ text: 'new photos', reason: 'kind' }] }
            : { items: [ITEM], next_cursor: null };
        return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    };
    const t = await boot({ appOpts: { feedFetch, startRelay: false, startSharingWorker: false } });

    await check('/pulse answers 200, mounts the shared feed and loads ov-home.js', async () => {
        const r = await t.get('/pulse');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /id="ov-pulse-feed"/, 'the page names the mount the shared feed draws into');
        assert.match(r.text, /<script src="\/shared\/ov-home\.js\?v=[a-f0-9]+" defer><\/script>/, 'ov-home.js is loaded from this site\'s own pinned copy');
        assert.match(r.text, /js\/pulse\.js/, 'the page loads the script that mounts the feed');
    });

    await check('/pulse renders the first page of the same feed for the crawlers', async () => {
        const r = await t.get('/pulse');
        assert.match(r.text, /Hello from the one feed/, 'the first page is in the HTML');
        assert.match(r.text, /pulse-card/, 'as a plain card with its title as the link');
        assert.match(r.text, /Pulse: what is happening across OpenVibe/, 'the page says what it is');
        assert.match(r.text, /rel="canonical" href="https:\/\/openvibe\.community\/pulse"/, 'one canonical address');
    });

    await check('/pulse still answers when Network does not', async () => {
        const down = await boot({ appOpts: { feedFetch: async () => { throw new Error('Network is down'); }, startRelay: false, startSharingWorker: false } });
        const r = await down.get('/pulse');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /Loading the feed/);
        await down.close();
    });

    await check('the page itself: the mount, the cards and the note', () => {
        const html = pulsePage({ items: [ITEM] });
        assert.match(html, /id="ov-pulse-feed"/);
        assert.match(html, /Hello from the one feed/);
        assert.match(html, /<a class="thread-title" href="https:\/\/openvibe\.community\/forum\/general\/hello">/);
        assert.match(html, /Community/, 'the card says which site it came from');
        assert.match(html, /<title>Pulse: what is happening across OpenVibe/);
        const empty = pulsePage({ items: [] });
        assert.match(empty, /Loading the feed/, 'no rows yet: the page says the feed is loading');
    });

    await check('the feed proxy: an empty feed when Network does not answer, and it says so', async () => {
        const proxy = createFeedProxy({ config: { networkUrl: 'https://openvibe.network' }, fetchImpl: async () => { throw new Error('Network is down'); } });
        const out = await proxy.read('/api/v1/feed', { limit: '20' }, null, 100);
        assert.deepStrictEqual(out.body.items, []);
        assert.strictEqual(out.unavailable, true, 'the page can tell that the feed did not answer');
    });

    await check('the page script mounts the shared feed on the page\'s mount', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pulse.js'), 'utf8');
        assert.match(src, /OpenVibeHome/, 'it uses the shared feed');
        assert.match(src, /.feed\(mount,/, 'and mounts it on the page\'s element');
        assert.match(src, /frameBase: '\/api\/v1'/, 'reading Community\'s own feed proxy, the same feed as the menu');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
