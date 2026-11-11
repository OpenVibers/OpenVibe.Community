'use strict';
/**
 * GET /api/v1/feed (the menu's Feed on every site): one stream from Pulse, newest first, as cards by kind (a paste or
 * a status is a post, a Live clip a clip, a Wiki page a wiki page, a Quest badge a quest, a busy chat hour a chat, a
 * Today event an event, a day's new Network accounts a member), the pictures and text a post carries, Community's own
 * counts, the site/q/following filters, and the shape openvibe-shared's ov-home.js feed() draws.
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
const LIVE = { streams: [{ username: 'alex', started_at: new Date().toISOString() },
    { username: 'alex', started_at: new Date(Date.now() - 40 * 60_000).toISOString() },
    { username: 'ada', started_at: new Date().toISOString() }] };
const feedFetch = async (url) => {
    const u = String(url);
    return { ok: /\/api\/(frame|streams)/.test(u), json: async () => (/\/api\/streams/.test(u) ? LIVE : FRAME) };
};

// 1×1 PNG, enough for the attachment upload and the screenshot paste (the bytes decide the type).
const zlib = require('zlib');
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);

const at = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19);

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { feedFetch, startRelay: false, startSharingWorker: false, forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    await check('feed examples are generated from current Pulse cards and search accepts natural filters', async () => {
        const examples = await t.get('/api/v1/feed/examples');
        assert.strictEqual(examples.status, 200, examples.text);
        assert.ok(Array.isArray(examples.json().examples));
        const empty = await t.get('/api/v1/feed/search');
        assert.strictEqual(empty.status, 400);
    });
    const net = t.network;
    const db = t.app.locals.db;
    const pulse = t.app.locals.pulse;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    const netSvc = net.signService({ cap: ['community.pulse.write'] });

    // A public text paste and a screenshot paste (its picture is the first thing the Feed can show).
    const textPaste = (await t.app.locals.pastes.createText(asAlex, { title: 'Public one', content: 'The first line of a public paste.' })).paste;
    const shot = (await t.app.locals.pastes.createScreenshot(asAlex, { title: 'A shot', content: 'A tiny cat on a screen' }, { buffer: PNG, originalname: 'cat.png' })).paste;
    const clip = await t.get('/api/v1/pulse/items', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${netSvc}`, 'x-ov-subject': alex.subject_id },
        body: JSON.stringify({ ref: { service: 'live', type: 'clip', id: 'c1' }, title: 'Great clip', url: 'https://openvibe.live/clip/c1', media: { thumb: 'https://openvibe.media/c1.webp', preview: 'https://openvibe.media/c1.mp4', ratio: 1.5, length: 18 } }) });
    assert.strictEqual(clip.status, 201, clip.text);

    // One fixture for every remaining kind Pulse can carry (the other services' items are pushed, never read per request).
    const fixtures = [
        ['live', 'stream', 'l1', 'Alex went live', 'https://openvibe.live/alex', alex.subject_id, 'user', 12],
        ['live', 'clip', 'c2', 'A second clip', 'https://openvibe.live/clip/c2', alex.subject_id, 'user', 13],
        ['media-hub', 'video', 'v1', 'A video', 'https://openvibe.video/v/1', alex.subject_id, 'user', 14],
        ['pics', 'picture', 'p1', 'A picture', 'https://openvibe.pics/p/1', alex.subject_id, 'user', 15],
        ['meme', 'meme', 'm1', 'A meme', 'https://openvibe.meme/m/1', alex.subject_id, 'user', 16],
        ['games', 'level', 'g1', 'Reached level 5', 'https://openvibe.games/', alex.subject_id, 'user', 17],
        ['blog', 'post', 'b1', 'A blog post', 'https://openvibe.blog/b/1', alex.subject_id, 'user', 18],
        ['wiki', 'page', 'w1', 'Wiki: a page', 'https://openvibe.wiki/w/1', sam.subject_id, 'user', 19],
        ['quest', 'badge', 'q1', 'Finished a quest: First Post', 'https://openvibe.quest/', sam.subject_id, 'user', 20],
        ['chat', 'hour', 'general:2026-11-09T10', '#general: 12 messages this hour', 'https://openvibe.chat/rooms/general', null, 'system', 21],
        ['today', 'event', 'e1', 'Coming up: A launch party', 'https://openvibe.today/e/e1', alex.subject_id, 'user', 22],
        ['network', 'members', '2026-11-09', '5 people joined today', 'https://openvibe.network/stats', null, 'system', 23],
    ];
    for (const [service, type, id, title, url, actor, origin, minsAgo] of fixtures) {
        await db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, origin, visibility, occurred_at, text, picture_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?)`)
            .run(service, type, id, title, url, actor, origin, at(minsAgo), type === 'event' ? 'Come along' : '', null);
        if (type === 'event') await db.prepare('UPDATE pulse_items SET starts_at = ? WHERE source_service = ? AND source_id = ?')
            .run(new Date(Date.now() + 60 * 60_000).toISOString().replace('T', ' ').slice(0, 19), service, id);
    }
    await db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, origin, visibility, occurred_at)
        VALUES ('pics', 'picture', 'p2', 'Another picture', 'https://openvibe.pics/p/2', ?, 'user', 'public', ?)`).run(alex.subject_id, at(15.5));

    // Make the paste's counts real so the card has Community's own views, likes and comments.
    await db.prepare('UPDATE pastes SET views = 7, likes = 3 WHERE slug = ?').run(textPaste.slug);
    await db.prepare(`INSERT INTO comment_threads (ref_service, ref_type, ref_id, comment_count, access_id) VALUES ('community', 'paste', ?, 2, 'feed-test')`).run(textPaste.slug);

    await check('the feed: newest first, cards by kind, the shape the menu draws', async () => {
        const r = await t.get('/api/v1/feed?limit=40');
        assert.strictEqual(r.status, 200, r.text);
        const j = r.json();
        const kinds = new Set(j.items.map((x) => x.kind));
        for (const k of ['stream', 'clip', 'video', 'pic', 'paste', 'meme', 'game', 'update', 'wiki', 'quest', 'chat', 'event', 'member']) assert.ok(kinds.has(k), `kind ${k} (${[...kinds]})`);
        assert.ok('next_cursor' in j);
        for (const x of j.items) for (const k of ['id', 'kind', 'url', 'title', 'text', 'at', 'site', 'site_name', 'actor', 'media', 'counts']) assert.ok(k in x, `${k} on every card`);
        const c = j.items.find((x) => x.url === 'https://openvibe.live/clip/c1');
        assert.strictEqual(c.site, 'live');
        assert.strictEqual(c.site_name, 'Live');
        assert.strictEqual(c.actor.name, 'Alex');
        assert.deepStrictEqual(c.media, { thumb: 'https://openvibe.media/c1.webp', preview: 'https://openvibe.media/c1.mp4', ratio: 1.5, length: 18 });
        const photos = j.items.find((x) => x.kind === 'pic');
        assert.strictEqual(photos.title, 'Alex added 2 photos');
        assert.strictEqual(photos.group.count, 2);
        assert.deepStrictEqual(photos.group.items.map((x) => x.url), ['https://openvibe.pics/p/1', 'https://openvibe.pics/p/2']);
    });

    await check('GET /feed is server rendered, kind chips keep the page crawlable and Older carries a cursor', async () => {
        const r = await t.get('/feed?kind=video');
        assert.strictEqual(r.status, 200, r.text);
        assert.ok(r.text.includes('A video'), 'card text is in the response HTML');
        assert.ok(r.text.includes('https://openvibe.video/v/1'), 'card link is in the response HTML');
        assert.ok(r.text.includes('schema.org') && r.text.includes('ItemList'), 'ItemList JSON-LD is present');
        assert.ok(r.text.includes('Older'), 'the page has a crawlable older-page link');
        assert.ok(r.text.includes('id="feed-search"') && r.text.includes('Try:'), 'the page offers feed search and current examples');
        const searched = await t.get('/feed?q=videos');
        assert.ok(searched.text.includes('A video') && searched.text.includes('name="q" value="videos"'), 'the page applies a natural kind search');
    });

    await check('a paste and a screenshot paste carry their text and first picture; the counts are Community\'s', async () => {
        const j = (await t.get('/api/v1/feed?limit=40')).json();
        const p = j.items.find((x) => x.title === 'Public one');
        assert.strictEqual(p.text, 'The first line of a public paste.');
        assert.strictEqual(p.kind, 'paste');
        assert.deepStrictEqual(p.counts, { views: 7, likes: 3, comments: 2 });
        const s = j.items.find((x) => x.title === 'A shot');
        const stored = await db.prepare('SELECT screenshot_url FROM pastes WHERE slug = ?').get(shot.slug);
        assert.strictEqual(s.text, 'A tiny cat on a screen');
        assert.strictEqual(s.media.thumb, stored.screenshot_url);
        assert.strictEqual(s.media.ratio, 16 / 9);
    });

    await check('trending pictures are woven in: https, with a picture, kinds the feed shows', async () => {
        const j = (await t.get('/api/v1/feed')).json();
        const tr = j.items.filter((x) => x.label === 'Trending');
        assert.deepStrictEqual(tr.map((x) => x.title), ['A trending video'], 'only the https one with a picture');
        assert.strictEqual(tr[0].kind, 'video');
        assert.strictEqual(tr[0].media.thumb, 'https://openvibe.media/t/1.webp');
    });

    await check('LIVE only for a channel that is live now', async () => {
        const feedTools = require('../server/pulse/feed');
        const current = await feedTools.createLiveNow({ liveUrl: 'https://openvibe.live', fetchImpl: feedFetch })();
        assert.strictEqual(current.get('alex').length, 2, 'both active stream starts are retained for one channel');
        assert.ok(feedTools.isCurrentLive({ url: 'https://openvibe.live/@alex', at: new Date(Date.now() - 40 * 60_000).toISOString() }, current));
        const mk = (id, who, at = null) => t.get('/api/v1/pulse/items', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${netSvc}`, 'x-ov-subject': alex.subject_id },
            body: JSON.stringify({ ref: { service: 'live', type: 'stream', id }, title: `${who} went live: ${at ? 'an older stream' : 'a stream'}`, url: `https://openvibe.live/@${who}`, ...(at ? { occurred_at: at } : {}) }) });
        assert.strictEqual((await mk('s1', 'ada')).status, 201);
        assert.strictEqual((await mk('s2', 'bo')).status, 201);
        assert.strictEqual((await mk('s3', 'alex', new Date(Date.now() - 2 * 86_400_000).toISOString())).status, 201);
        const j = (await t.get('/api/v1/feed?site=live&limit=40')).json();
        const by = Object.fromEntries(j.items.map((x) => [x.url, [x.kind, x.live_now]]));
        assert.deepStrictEqual(by['https://openvibe.live/@ada'], ['live', true], 'ada is on the live list');
        assert.deepStrictEqual(by['https://openvibe.live/@bo'], ['stream', false], 'bo went live earlier: a stream that happened, never LIVE');
        const older = j.items.find((x) => x.title === 'alex went live: an older stream');
        assert.deepStrictEqual([older.kind, older.live_now], ['stream', false], 'an old broadcast stays ended while the same channel is live again');
        for (const kind of ['live', 'stream']) {
            const filtered = (await t.get(`/api/v1/feed?kind=${kind}&limit=40`)).json();
            assert.ok(filtered.items.length > 0, `${kind} has a card`);
            assert.ok(filtered.items.every((x) => x.kind === kind), `${kind} filters the displayed kind`);
        }

    });

    await check('a kind filters the stream, a site filters the stream, q searches title and text', async () => {
        const j = (await t.get('/api/v1/feed?kind=wiki&limit=40')).json();
        assert.ok(j.items.length >= 1 && j.items.every((x) => x.kind === 'wiki'), JSON.stringify(j.items.map((x) => x.kind)));
        const none = (await t.get('/api/v1/feed?kind=no-such-kind')).json();
        assert.ok(none.items.length > 0, 'an unknown kind is ignored, not a 400');
        const site = (await t.get('/api/v1/feed?site=live&limit=40')).json();
        assert.ok(site.items.length >= 1 && site.items.every((x) => x.site === 'live'), JSON.stringify(site.items.map((x) => x.site)));
        const q = (await t.get('/api/v1/feed?q=cat&limit=40')).json();
        assert.ok(q.items.length >= 1 && q.items.every((x) => /cat/i.test(x.title) || /cat/i.test(x.text)), JSON.stringify(q.items.map((x) => x.title)));
        const text = (await t.get('/api/v1/feed?q=tiny%20cat&limit=40')).json();
        assert.ok(text.items.some((x) => x.title === 'A shot'), 'text is searched too');
    });

    await check('following=1 is the signed-in person\'s follows; signed out it is refused', async () => {
        net.addFollow(sam.subject_id, 'channel', alex.subject_id);
        const j = (await t.get('/api/v1/feed?following=1&limit=40', { cookies: [`ov_token=${samJwt}`] })).json();
        assert.ok(j.items.length >= 1, JSON.stringify(j.items));
        assert.ok(j.items.every((x) => x.actor && x.actor.name === 'Alex'), JSON.stringify(j.items.map((x) => [x.title, x.actor])));
        assert.ok(j.items.some((x) => x.title === 'Alex went live'));
        const r = await t.get('/api/v1/feed?following=1');
        assert.strictEqual(r.status, 401);
        assert.strictEqual(r.json().code, 'feed.sign_in_required');
    });

    await check('cross-site: any OpenVibe site reads it from the browser (CORS, no credentials)', async () => {
        const r = await t.get('/api/v1/feed', { headers: { origin: 'https://openvibe.video' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'a site off the write list still reads it');
        assert.ok(!r.headers.get('access-control-allow-credentials'), 'never with cookies');
        const pre = await t.get('/api/v1/feed', { method: 'OPTIONS', headers: { origin: 'https://open.shoes', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
        assert.strictEqual(pre.status, 204);
        assert.match(pre.headers.get('access-control-allow-headers') || '', /Authorization/);
        const wall = await t.get('/api/v1/pulse', { headers: { origin: 'https://openvibe.pics' } });
        assert.strictEqual(wall.headers.get('access-control-allow-origin'), '*', 'the wall too');
        const write = await t.get('/api/v1/pulse/items', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
        assert.ok(!write.headers.get('access-control-allow-origin'), 'a write from elsewhere gets no CORS');
    });

    await check('small pages retain every Pulse item, including the final partially read page', async () => {
        const all = (await t.get('/api/v1/feed?limit=40')).json().items.filter((x) => x.id.startsWith('p:'));
        for (const limit of [1, 4]) {
            const seen = []; let cursor = ''; const cursors = new Set();
            do {
                const r = await t.get(`/api/v1/feed?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
                assert.strictEqual(r.status, 200, r.text);
                const page = r.json();
                assert.ok(page.items.length <= limit, 'trending counts toward the page limit');
                seen.push(...page.items.filter((x) => x.id.startsWith('p:')).flatMap((x) => x.group ? x.group.items.map((y) => y.id) : [x.id]));
                cursor = page.next_cursor;
                if (cursor) { assert.ok(!cursors.has(cursor), 'cursor advances'); cursors.add(cursor); }
                assert.ok(cursors.size < 40, 'pagination terminates');
            } while (cursor);
            assert.deepStrictEqual([...seen].sort(), all.flatMap((x) => x.group ? x.group.items.map((y) => y.id) : [x.id]).sort(), `limit=${limit}: no missing or repeated rows`);
        }
    });

    await check('filtered pages keep scanning after an empty bounded page', async () => {
        // More than the eight 40-row scans in one call, ahead of the existing Wiki fixture.
        await db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, origin, visibility, occurred_at)
            SELECT 'feed-scan-test', 'event', n::text, 'Unrelated event', 'https://openvibe.today/', 'system', 'public', ?
            FROM generate_series(1, 321) n`).run(at(1));
        try {
            const first = (await t.get('/api/v1/feed?site=wiki&limit=1')).json();
            assert.deepStrictEqual(first.items, []);
            assert.ok(first.next_cursor, 'empty bounded scan is not the end');
            const next = (await t.get(`/api/v1/feed?site=wiki&limit=1&cursor=${encodeURIComponent(first.next_cursor)}`)).json();
            assert.strictEqual(next.items.length, 1);
            assert.strictEqual(next.items[0].site, 'wiki');
        } finally { await db.prepare("DELETE FROM pulse_items WHERE source_service = 'feed-scan-test'").run(); }
    });

    // ── POST /api/v1/posts with pictures: the Feed shows it at once ──
    const upload = async (jwt) => {
        const fd = new FormData();
        fd.append('file', new Blob([PNG], { type: 'image/png' }), 'cat.png');
        return await t.get('/api/v1/spaces/general/attachments', { method: 'POST', body: fd, cookies: [`ov_token=${jwt}`] });
    };
    const json = async (jwt, path, body) => await t.get(path, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    await check('a post with a picture: alt is required, then the Feed has its text and picture at once', async () => {
        const up = await upload(alexJwt);
        assert.strictEqual(up.status, 201, up.text);
        const mediaId = up.json().attachment.media_id;
        const bad = await json(samJwt, '/api/v1/posts', { text: 'no', pictures: [{ media_id: mediaId, alt: '' }] });
        assert.strictEqual(bad.status, 400, bad.text);
        const r = await json(alexJwt, '/api/v1/posts', { text: 'Look at this cat', pictures: [{ media_id: mediaId, alt: 'A white cat' }] });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().pictures[0].alt, 'A white cat');
        const j = (await t.get('/api/v1/feed?q=Look%20at%20this%20cat&limit=40')).json();
        assert.strictEqual(j.items.length, 1, JSON.stringify(j.items));
        assert.strictEqual(j.items[0].kind, 'post');
        assert.strictEqual(j.items[0].text, 'Look at this cat');
        assert.ok(j.items[0].media && j.items[0].media.thumb.endsWith(`/o/${mediaId}`));
        assert.deepStrictEqual(j.items[0].counts, { views: 0, likes: 0, comments: 0 });
        const reused = await json(alexJwt, '/api/v1/posts', { text: 'Again', pictures: [{ media_id: mediaId, alt: 'stolen' }] });
        assert.strictEqual(reused.status, 400, reused.text);
    });

    await check('a picture uploaded straight to Media (no local attachment row) is checked for its owner and attached', async () => {
        const stored = await t.app.locals.pasteMedia.upload({ buffer: PNG, filename: 'direct.png', mime: 'image/png', owner: alex.subject_id, visibility: 'unlisted' });
        const r = await json(alexJwt, '/api/v1/posts', { text: 'Straight from Media', pictures: [{ media_id: stored.key, alt: 'Direct cat' }] });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().pictures[0].alt, 'Direct cat');
        const j = (await t.get('/api/v1/feed?q=Straight%20from%20Media&limit=40')).json();
        assert.strictEqual(j.items.length, 1, JSON.stringify(j.items));
        assert.ok(j.items[0].media.thumb.endsWith(`/o/${stored.key}`));
        const row = await db.prepare('SELECT alt FROM attachments WHERE media_id = ?').get(stored.key);
        assert.strictEqual(row.alt, 'Direct cat');
    });

    await check('a post keeps a PDF composer attachment and renders it as a download', async () => {
        const id = 'att_01ABCDEFGHJKMNPQRSTVWXYZ01';
        const original = global.fetch;
        let kept = false;
        global.fetch = (url, options) => {
            if (String(url).endsWith(`/api/v1/attachments/${id}/keep`)) {
                kept = options.method === 'POST' && options.headers.Authorization === `Bearer ${alexJwt}`;
                return Promise.resolve(new Response(JSON.stringify({ id, kind: 'file', name: 'notes.pdf', mime: 'application/pdf', size: 123, url: `https://openvibe.media/a/${id}/notes.pdf` }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return original(url, options);
        };
        try {
            const r = await json(alexJwt, '/api/v1/posts', { text: 'Here are my notes', attachments: [id] });
            assert.strictEqual(r.status, 201, r.text);
            assert.ok(kept, 'Media keeps the file using the person token');
            assert.strictEqual(r.json().attachments[0].id, id);
            const row = await db.prepare('SELECT filename, mime, url FROM attachments WHERE media_id = ?').get(id);
            assert.strictEqual(row.filename, 'notes.pdf');
            assert.strictEqual(row.mime, 'application/pdf');
            assert.ok(row.url.endsWith('/notes.pdf'));
            const page = await t.get(new URL(r.json().url).pathname);
            assert.ok(page.text.includes('notes.pdf'), 'the post page links the file');
        } finally { global.fetch = original; }
    });

    await check('a signed-out post, a text with extra fields and more than four pictures are refused', async () => {
        assert.strictEqual((await t.get('/api/v1/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x' }) })).status, 401);
        let r = await json(alexJwt, '/api/v1/posts', { text: 'x', secret: 1 });
        assert.strictEqual(r.status, 400);
        r = await json(alexJwt, '/api/v1/posts', { text: 'x', pictures: [{ media_id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', alt: '1' }] });
        assert.strictEqual(r.status, 400);
    });

    await done(t);
})();
