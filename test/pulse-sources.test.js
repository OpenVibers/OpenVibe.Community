'use strict';
/**
 * Pulse's due-based public sources (server/pulse/sources.js): Today's calendar, Network's open stats and Quest's
 * public badges fill Pulse without any per-feed call, and pulse_source_runs makes each source wait its interval.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

(async () => {
    const today = day(Date.now());
    const yesterday = day(Date.now() - 86_400_000);
    const badgeAt = iso(Date.now() - 3_600_000);
    const calls = [];
    let liveStreams = [];
    let extraContent = [];
    let galleryRows = [
        { id: 'pic_01JAB2C3D4E5F6G7H8J9K0MNPQ', title: 'First photo', author: 'Alex', listed: true, published_at: badgeAt,
            links: { page: 'https://openvibe.pics/i/firstpic', thumb: 'https://openvibe.pics/i/firstpic/thumb.webp' }, width: 800, height: 600 },
        { id: 'pic_01JAB2C3D4E5F6G7H8J9K0MNPR', title: 'Second photo', author: 'Alex', listed: true, published_at: badgeAt,
            links: { page: 'https://openvibe.pics/i/secondpic', thumb: 'https://openvibe.pics/i/secondpic/thumb.webp' }, width: 800, height: 600 },
        { id: 'pic_01JAB2C3D4E5F6G7H8J9K0MNPS', title: 'Unlisted photo', author: 'Alex', listed: false, published_at: badgeAt,
            links: { page: 'https://openvibe.pics/i/privatep', thumb: 'https://openvibe.pics/i/privatep/thumb.webp' }, width: 800, height: 600 },
    ];
    let eventOwner = null;
    const sourcesFetch = async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u.includes('/api/v1/events')) return { ok: true, json: async () => ({ events: [
            { id: 'tev_01JAB2C3D4E5F6G7H8J9K0MNPQ', kind: 'event', title: 'Launch party', description: 'Come along', starts_at: iso(Date.now() + 86_400_000), created_at: iso(Date.now() - 60_000), visibility: 'public', status: 'scheduled', owner_subject: eventOwner, url: null },
            { id: 'tev_cancelled', kind: 'event', title: 'Cancelled', visibility: 'public', status: 'cancelled', owner_subject: null },
            { id: 'tev_private', kind: 'event', title: 'Private', visibility: 'followers', status: 'scheduled', owner_subject: null },
        ] }) };
        if (u.includes('/api/v1/stats')) return { ok: true, json: async () => ({ accounts: { total: 1234, daily: [{ day: today, n: 5 }, { day: yesterday, n: 3 }, { day: '2026-01-01', n: 0 }] } }) };
        if (u.includes('/api/v1/entries')) return { ok: true, json: async () => ({ entries: [{ slug: 'open-source-meme', title: 'Open source meme', summary: 'A public entry', published_at: iso(Date.now() - 120_000) }], next_cursor: null }) };
        if (u.includes('/api/v1/gallery')) return { ok: true, json: async () => ({ pictures: galleryRows, next: null }) };
        if (u.includes('/api/rundown/streams')) return { ok: true, json: async () => ({ streams: [{ stream_id: 123, live: false,
            title: 'Night stream', started_at: badgeAt, thumbnail_url: 'https://openvibe.media/night.webp',
            episode: { title: 'The night sky', logline: 'A recap', aired_at: badgeAt, audience: 'public' } }], next: null }) };
        if (u.endsWith('/api/streams')) return { ok: true, json: async () => ({ streams: liveStreams }) };
        if (u.includes('/api/content/feed')) return { ok: true, json: async () => ({ items: [
            { id: 123, kind: 'vod', title: 'Night stream', href: 'https://openvibe.video/watch?v=night', thumbnail_url: 'https://openvibe.media/night.webp', created_at: badgeAt, channel: { username: 'alex', display_name: 'Alex' }, duration_seconds: 500 },
            { id: 124, kind: 'clip', title: 'Night clip', href: 'https://openvibe.video/clip/night', thumbnail_url: 'https://openvibe.media/clip.webp', created_at: badgeAt, channel: { username: 'alex', display_name: 'Alex' }, duration_seconds: 25 },
            ...extraContent,
        ], next: null, sources: { vods: 'ok', clips: 'ok' }, partial: false }) };
        if (u.includes('/api/v1/apps/gallery')) return { ok: true, json: async () => ({ spaces: [{
            id: 'spc_01JAB2C3D4E5F6G7H8J9K0MNPQ', name: 'A shared map', description: 'A map of places',
            owner_name: 'Alex', url: 'https://map.openvibe.website', published_at: Date.now() - 60_000,
        }], next_cursor: null }) };
        if (u.includes('/badges')) return { ok: true, json: async () => ({ badges: [
            { id: 'first-post', name: 'First Post', awarded_at: badgeAt },
            { id: 'old-badge', name: 'Old Badge', awarded_at: iso(Date.now() - 90 * 86_400_000) },
        ] }) };
        if (u.includes('/achievements/feed')) return { ok: true, json: async () => ({ items: [
            { player: eventOwner, title: 'scraplandia', title_name: 'Scraplandia', id: 'first-haul', name: 'First Haul', description: 'Find your first haul', unlocked_at: badgeAt },
        ], next: null }) };
        return { ok: false, status: 404, json: async () => ({}) };
    };

    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { sourcesFetch, startRelay: false, startSharingWorker: false } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    eventOwner = alex.subject_id;
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    await t.app.locals.pastes.createText(asAlex, { title: 'A paste', content: 'Hello' });

    await check('the due job fills today, the member count and a recent Quest badge, and skips old/cancelled rows', async () => {
        const out = await t.app.locals.pulseSources.runOnce({ force: true });
        const by = Object.fromEntries(out.map((x) => [x.name, x]));
        assert.strictEqual(by['today-events'].items, 1, JSON.stringify(out));
        assert.strictEqual(by['network-members'].items, 2);
        assert.strictEqual(by['quest-badges'].items, 1);
        assert.strictEqual(by['play-achievements'].items, 1);
        assert.strictEqual(by['meme-entries'].items, 1);
        assert.strictEqual(by['public-pictures'].items, 2);
        assert.strictEqual(by['rundown-episodes'].items, 1);
        assert.strictEqual(by['public-content'].items, 2);
        assert.strictEqual(by['public-spaces'].items, 1);
        const feed = (await t.get('/api/v1/feed?limit=40')).json();
        const ev = feed.items.find((x) => x.kind === 'event');
        assert.strictEqual(ev.title, 'Coming up: Launch party');
        assert.match(ev.text, /^Starts .* UTC · Come along$/);
        assert.strictEqual(ev.actor.name, 'Alex');
        const members = feed.items.filter((x) => x.kind === 'member');
        assert.deepStrictEqual(members.map((x) => x.title).sort(), [`3 people joined on ${yesterday}`, '5 people joined today']);
        assert.ok(members.every((x) => x.actor === null && x.site === 'network'));
        const q = feed.items.find((x) => x.kind === 'quest');
        assert.strictEqual(q.title, 'Finished a quest: First Post');
        assert.strictEqual(q.actor.name, 'Alex');
        assert.ok(feed.items.some((x) => x.kind === 'game' && x.title === 'Unlocked First Haul in Scraplandia'));
        const meme = feed.items.find((x) => x.kind === 'meme');
        assert.strictEqual(meme.title, 'Open source meme');
        assert.strictEqual(meme.text, 'A public entry');
        assert.strictEqual(meme.url, 'https://openvibe.meme/m/open-source-meme');
        const episode = feed.items.find((x) => x.kind === 'episode');
        assert.strictEqual(episode.title, 'Rundown: The night sky');
        assert.strictEqual(episode.url, 'https://openvibe.live/rundown/e/123');
        assert.ok(feed.items.some((x) => x.kind === 'video' && x.title === 'Recording: Night stream'));
        assert.ok(feed.items.some((x) => x.kind === 'clip' && x.title === 'Night clip'));
        assert.ok(feed.items.some((x) => x.kind === 'space' && x.title === 'A shared map' && x.actor.name === 'Alex'));
        const photos = feed.items.find((x) => x.site === 'pics');
        assert.strictEqual(photos.title, 'Alex added 2 photos');
        assert.strictEqual(photos.group.count, 2);
        assert.ok(!feed.items.some((x) => x.title.includes('Unlisted photo')));
        assert.ok(!feed.items.some((x) => /Cancelled|Private|Old Badge/.test(x.title)), feed.items.map((x) => x.title).join(' | '));
    });

    await check('a source that just ran is not due again; the next time is remembered', async () => {
        const quiet = await t.app.locals.pulseSources.runOnce();
        assert.deepStrictEqual(quiet, []);
        const status = await t.app.locals.pulseSources.status();
        assert.deepStrictEqual(status.sources.sort(), ['meme-entries', 'network-members', 'play-achievements', 'public-content', 'public-pictures', 'public-spaces', 'quest-badges', 'rundown-episodes', 'today-events']);
        assert.strictEqual(status.runs.length, 9);
        assert.ok(status.runs.every((r) => r.next_run_at && r.last_run_at && !r.last_error));
    });

    await check('the job never runs a service call per feed request', async () => {
        const before = calls.length;
        await t.get('/api/v1/feed?limit=40');
        await t.get('/api/v1/feed?kind=event&limit=40');
        assert.strictEqual(calls.length, before, 'reading the Feed made no external call');
    });

    await check('an unpublished picture leaves the feed after the gallery refresh', async () => {
        galleryRows = galleryRows.slice(0, 1);
        await t.app.locals.pulseSources.runOnce({ force: true });
        const pictures = (await t.get('/api/v1/feed?site=pics')).json().items;
        assert.deepStrictEqual(pictures.map((x) => x.title), ['First photo']);
    });

    await check('a re-record that sends no text keeps the card\'s text; one that sends text replaces it', async () => {
        const store = require('../server/pulse/store');
        const key = { source_service: 'today', source_type: 'event', source_id: 'tev_keep', url: 'https://openvibe.today/e/tev_keep', origin: 'system', occurred_at: '2026-11-09T10:00:00Z' };
        await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep', text: 'Bring snacks' });
        let r = await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep (moved)' });
        assert.strictEqual(r.item.text, 'Bring snacks');
        assert.strictEqual(r.item.title, 'Event: Keep (moved)');
        r = await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep', text: '' });
        assert.strictEqual(r.item.text || '', '');
    });

    await check('times are one spelling, so a day reads in order whatever wrote it (ISO from Events, a space locally)', async () => {
        const store = require('../server/pulse/store');
        const db = t.app.locals.db;
        const base = { source_service: 'today', source_type: 'event', url: 'https://openvibe.today/e/x', origin: 'system' };
        await store.upsertItem(db, { ...base, source_id: 'order_iso', title: 'Event: Morning (ISO)', occurred_at: '2030-01-02T08:00:00.000Z' });
        await store.upsertItem(db, { ...base, source_id: 'order_space', title: 'Event: Evening (space)', occurred_at: '2030-01-02 20:00:00' });
        const rows = await db.prepare("SELECT source_id, occurred_at FROM pulse_items WHERE source_id LIKE 'order_%' ORDER BY occurred_at DESC").all();
        assert.deepStrictEqual(rows.map((r) => r.source_id), ['order_space', 'order_iso'], 'the evening one is newer');
        assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.occurred_at)), rows.map((r) => r.occurred_at).join(', '));
        assert.strictEqual(store.pulseTime('2030-01-02T08:00:00+02:00'), '2030-01-02 06:00:00', 'an offset is read, not dropped');
    });

    await check('a current broadcast stays one Live item until it becomes a recording', async () => {
        const db = t.app.locals.db;
        const item = (type, id) => db.prepare('SELECT title FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?').get('live', type, String(id));
        liveStreams = [{ id: 999, username: 'alex', display_name: 'Alex', title: 'Night stream', started_at: badgeAt },
            { id: 998, username: 'alex', display_name: 'Alex', title: 'Earlier live stream', started_at: iso(Date.parse(badgeAt) - 40 * 60_000) }];
        extraContent = [{ id: 125, kind: 'vod', title: 'Earlier broadcast', href: 'https://openvibe.video/watch?v=earlier',
            created_at: iso(Date.parse(badgeAt) - 20 * 60_000), channel: { username: 'alex', display_name: 'Alex' } }];
        await t.app.locals.pulseSources.runOnce({ force: true });
        assert.ok(await item('stream', 999));
        assert.ok(await item('stream', 998), 'both on-air stream IDs survive an older VOD on the same channel');
        assert.ok(!(await item('recording', 123)), 'a recording for the broadcast is suppressed while it is live');
        liveStreams = [];
        await t.app.locals.pulseSources.runOnce({ force: true });
        assert.ok(!(await item('stream', 999)), 'the ended Live item leaves when the recording arrives');
        assert.ok(!(await item('stream', 998)));
        assert.ok(await item('recording', 123));
    });

    await check('a Live recording names its channel\'s person (the one subject known by that username), and fills an older card', async () => {
        const db = t.app.locals.db;
        const { upsertProjection } = require('../server/pastes/store');
        const store = require('../server/pulse/store');
        const subjectOf = async (type, id) => (await db.prepare('SELECT actor_subject FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?')
            .get('live', type, String(id)) || {}).actor_subject || null;
        await upsertProjection(db, { subject_id: alex.subject_id, username: 'alex', display_name: 'Alex' });
        // An older card that the sync wrote before it knew the person (11-11's 70 of 112), and two people who share
        // the username "twin": nobody is guessed for them.
        await store.upsertItem(db, { source_service: 'live', source_type: 'recording', source_id: '126', title: 'Recording: Before', url: 'https://openvibe.video/watch?v=before',
            actor_name: 'Alex', origin: 'user', occurred_at: badgeAt });
        await upsertProjection(db, { subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA', username: 'twin', display_name: 'Twin A' });
        await upsertProjection(db, { subject_id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB', username: 'Twin', display_name: 'Twin B' });
        extraContent = [
            { id: 126, kind: 'vod', title: 'Before', href: 'https://openvibe.video/watch?v=before', created_at: badgeAt, channel: { username: 'alex', display_name: 'Alex' } },
            { id: 127, kind: 'vod', title: 'Twin stream', href: 'https://openvibe.video/watch?v=twin', created_at: badgeAt, channel: { username: 'twin', display_name: 'Twin' } },
        ];
        await t.app.locals.pulseSources.runOnce({ force: true });
        assert.strictEqual(await subjectOf('recording', 123), alex.subject_id, 'a new recording carries its channel\'s person');
        assert.strictEqual(await subjectOf('clip', 124), alex.subject_id, 'a clip too');
        assert.strictEqual(await subjectOf('recording', 126), alex.subject_id, 'an older card without a person is filled');
        assert.strictEqual(await subjectOf('recording', 127), null, 'a username two people share names nobody');
        const followed = await store.upsertItem(db, { source_service: 'live', source_type: 'recording', source_id: '126', title: 'Recording: Before', url: 'https://openvibe.video/watch?v=before',
            actor_subject: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA', actor_name: 'Alex', origin: 'user', occurred_at: badgeAt });
        assert.strictEqual(followed.item.actor_subject, alex.subject_id, 'a card\'s person, once known, never changes');
        extraContent = [];
    });

    await done(t);
})();
