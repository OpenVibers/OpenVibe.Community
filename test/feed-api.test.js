'use strict';
/**
 * GET /api/v1/feed (the menu's Feed on every site): one stream from Pulse, newest first, as cards by kind (a paste or a
 * thread is a post, a Live clip a clip), a kind filter, the network's trending pictures woven into the first page (from
 * Network's Frame, https and pictures only), and the shape openvibe-shared's ov-home.js feed() draws.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const FRAME = { cards: [
    { site: 'media-hub', title: 'Trending', items: [
        { title: 'A trending video', url: 'https://openvibe.video/v/1', meta: '1.2k views', image: { src: 'https://openvibe.media/t/1.webp' } },
        { title: 'No picture', url: 'https://openvibe.video/v/2' },
        { title: 'Not https', url: 'http://openvibe.video/v/3', image: { src: 'https://openvibe.media/t/3.webp' } },
    ] },
    { site: 'news', title: 'Top stories', items: [{ title: 'Not a kind the feed shows', url: 'https://openvibe.news/a', image: { src: 'https://openvibe.media/t/n.webp' } }] },
] };
const LIVE = { streams: [{ username: 'ada' }] };
const feedFetch = async (url) => ({ ok: /\/api\/(frame|streams)/.test(String(url)), json: async () => (/\/api\/streams/.test(String(url)) ? LIVE : FRAME) });

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { feedFetch } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    const pastes = t.app.locals.pastes;
    const svc = net.signService({ cap: ['community.pulse.write'] });

    await pastes.createText(asAlex, { title: 'Public one', content: 'x' });
    const clip = await t.get('/api/v1/pulse/items', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}`, 'x-ov-subject': alex.subject_id },
        body: JSON.stringify({ ref: { service: 'live', type: 'clip', id: 'c1' }, title: 'Great clip', url: 'https://openvibe.live/clip/c1' }) });
    assert.strictEqual(clip.status, 201, clip.text);

    await check('the feed: newest first, cards by kind, the shape the menu draws', async () => {
        const r = await t.get('/api/v1/feed');
        assert.strictEqual(r.status, 200, r.text);
        const j = r.json();
        const kinds = j.items.map((x) => x.kind);
        assert.ok(kinds.includes('clip') && kinds.includes('post'), `a clip and a post (${kinds})`);
        const c = j.items.find((x) => x.kind === 'clip');
        assert.strictEqual(c.title, 'Great clip');
        assert.strictEqual(c.site, 'live');
        assert.strictEqual(c.site_name, 'Live');
        assert.strictEqual(c.actor.name, 'Alex');
        assert.ok('next_cursor' in j);
        for (const x of j.items) for (const k of ['id', 'kind', 'url', 'title', 'site', 'site_name', 'counts']) assert.ok(k in x, `${k} on every card`);
    });

    await check('trending pictures are woven in: https, with a picture, kinds the feed shows', async () => {
        const j = (await t.get('/api/v1/feed')).json();
        const tr = j.items.filter((x) => x.label === 'Trending');
        assert.deepStrictEqual(tr.map((x) => x.title), ['A trending video'], 'only the https one with a picture');
        assert.strictEqual(tr[0].kind, 'video');
        assert.strictEqual(tr[0].media.thumb, 'https://openvibe.media/t/1.webp');
    });

    await check('LIVE only for a channel that is live now', async () => {
        const mk = (id, who) => t.get('/api/v1/pulse/items', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc}`, 'x-ov-subject': alex.subject_id },
            body: JSON.stringify({ ref: { service: 'live', type: 'stream', id }, title: `${who} went live: a stream`, url: `https://openvibe.live/@${who}` }) });
        assert.strictEqual((await mk('s1', 'ada')).status, 201);
        assert.strictEqual((await mk('s2', 'bo')).status, 201);
        const j = (await t.get('/api/v1/feed?kind=live')).json();
        const by = Object.fromEntries(j.items.map((x) => [x.url, x.live_now]));
        assert.strictEqual(by['https://openvibe.live/@ada'], true, 'ada is on the live list');
        assert.strictEqual(by['https://openvibe.live/@bo'], false, 'bo went live earlier and is not live now');
    });

    await check('a kind filters the stream', async () => {
        const j = (await t.get('/api/v1/feed?kind=clip')).json();
        assert.ok(j.items.length >= 1 && j.items.every((x) => x.kind === 'clip'), JSON.stringify(j.items.map((x) => x.kind)));
        const none = (await t.get('/api/v1/feed?kind=meme')).json();
        assert.deepStrictEqual(none.items, []);
    });

    await check('cross-site: answers any OpenVibe site (CORS)', async () => {
        const r = await t.get('/api/v1/feed', { headers: { origin: 'https://openvibe.video' } });
        assert.strictEqual(r.status, 200);
    });

    await done(t);
})();
