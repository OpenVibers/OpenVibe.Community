'use strict';
/**
 * The menu Feed's two Live cards (server/pulse/feed.js):
 *   a Rundown episode is kind 'rundown': the actor is The Rundown with its own mark, the streamer it is about is
 *   `subject` {name, handle, avatar}, the art is the episode's AI picture (the stream thumbnail when none), and it is
 *   never labelled "System"; a recording keeps its own actor, carries its length as `duration_s` (never a bare
 *   media.length badge) and links to the recording's watch page, not the channel.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');
const { createPulseSources } = require('../server/pulse/sources');

(async () => {
    const t = await boot();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const insert = t.db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, actor_name, origin, visibility, occurred_at, picture_url, media_ratio, media_length, subject_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?)`);
    await insert.run('live', 'episode', '3005', 'WW3 Prep: The Case Against Smooth Apologies', 'https://openvibe.live/rundown/e/3005',
        null, 'The Rundown', 'system', now, 'https://openvibe.media/f/rundown-picture.jpg', 1200 / 630, null,
        JSON.stringify({ name: 'Maticus', handle: '@maticus', avatar: 'https://openvibe.media/o/med_01M6SV8E153FM2T70WAF14TB4W' }));
    await insert.run('live', 'recording', 'vod-6393', 'Recording: WW3 prep', 'https://openvibe.video/watch?v=ivkluOg7ieQ',
        'usr_01KKT9AC60KM7CRTB3WN1Z8P56', 'Maticus', 'user', now, 'https://openvibe.media/t/vod-6393.jpg', 16 / 9, 5203, null);

    const page = await t.get('/api/v1/feed?limit=10');
    assert.strictEqual(page.status, 200);
    const body = await page.json();
    const rundown = body.items.find((x) => x.id === 'p:1');
    assert.ok(rundown, 'the Rundown card is in the feed');
    assert.strictEqual(rundown.kind, 'rundown');
    assert.deepStrictEqual(rundown.actor, { name: 'The Rundown', mark: 'rundown', avatar: null });
    assert.deepStrictEqual(rundown.subject, { name: 'Maticus', handle: '@maticus', avatar: 'https://openvibe.media/o/med_01M6SV8E153FM2T70WAF14TB4W' });
    assert.strictEqual(rundown.image, 'https://openvibe.media/f/rundown-picture.jpg');
    assert.strictEqual(rundown.media.thumb, 'https://openvibe.media/f/rundown-picture.jpg');
    assert.ok(Math.abs(rundown.media.ratio - 1200 / 630) < 1e-9, 'the AI picture keeps its 1200×630 ratio');
    assert.strictEqual(rundown.label, undefined, 'The Rundown, not "System"');
    assert.deepStrictEqual(rundown.ref, { service: 'live', kind: 'episode', id: '3005' }, 'the card names its own ref for the view store');
    assert.ok(rundown.url.endsWith('/rundown/e/3005'));

    const recording = body.items.find((x) => x.id === 'p:2');
    assert.ok(recording, 'the recording is in the feed');
    assert.strictEqual(recording.kind, 'video');
    assert.strictEqual(recording.actor.name, 'Maticus');
    assert.deepStrictEqual(recording.ref, { service: 'live', kind: 'recording', id: 'vod-6393', creator: 'usr_01KKT9AC60KM7CRTB3WN1Z8P56' }, 'the creator is the card\'s subject');
    assert.strictEqual(recording.duration_s, 5203, 'the length is a duration, not a bare number');
    assert.ok(!recording.media.length, 'no bare length badge on a recording');
    assert.strictEqual(recording.media.thumb, 'https://openvibe.media/t/vod-6393.jpg');
    assert.strictEqual(recording.url, 'https://openvibe.video/watch?v=ivkluOg7ieQ', "the recording's watch page, not the channel");

    const only = await t.get('/api/v1/feed?kind=rundown&limit=10');
    const onlyBody = await only.json();
    assert.deepStrictEqual(onlyBody.items.map((x) => x.kind), ['rundown'], 'kind=rundown filters to the episode');

    // The stored Pulse item carries the subject and duration too (the API a service reads).
    const pulse = await t.get('/api/v1/pulse');
    const items = (await pulse.json()).items;
    const pRundown = items.find((x) => x.source.type === 'episode');
    assert.deepStrictEqual(pRundown.subject, { name: 'Maticus', handle: '@maticus', avatar: 'https://openvibe.media/o/med_01M6SV8E153FM2T70WAF14TB4W' });
    assert.strictEqual(pRundown.duration_s, undefined);
    const pRecording = items.find((x) => x.source.type === 'recording');
    assert.strictEqual(pRecording.duration_s, 5203);

    // ── The Live source itself: an episode's picture and subject are stored with the Pulse item ──
    const live = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url.startsWith('/api/rundown/streams')) return res.end(JSON.stringify({ streams: [{
            stream_id: 4242, live: false, thumbnail_url: 'https://openvibe.media/t/stream-thumb.jpg',
            user: { username: 'maticus', display_name: 'Maticus', avatar_url: 'https://openvibe.media/o/med_maticus' },
            episode: { title: 'The Fridge Files', logline: 'A night of cold takes.', aired_at: '2026-11-12 03:00:00', audience: 'public', picture_url: 'https://openvibe.media/f/episode-pic.jpg' },
        }], next: null }));
        res.statusCode = 404; res.end('{}');
    });
    await new Promise((r) => live.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${live.address().port}`;
    const sources = createPulseSources({ db: t.db, config: { liveUrl: url, todayUrl: url, todayInternalUrl: url, networkUrl: url, networkInternalUrl: url, questUrl: url, questInternalUrl: url, memeUrl: url, memeInternalUrl: url, picsUrl: url, spaceUrl: url, playUrl: url } });
    const ran = await sources.runOnce({ force: true });
    const rundownSource = ran.find((x) => x.name === 'rundown-episodes');
    assert.ok(rundownSource && rundownSource.items === 1, 'the Rundown source read one episode');
    const stored = await t.db.prepare("SELECT * FROM pulse_items WHERE source_service = 'live' AND source_type = 'episode' AND source_id = '4242'").get();
    assert.strictEqual(stored.title, 'The Fridge Files', 'the actor carries the name, so the title does not repeat it');
    assert.strictEqual(stored.actor_name, 'The Rundown');
    assert.strictEqual(stored.picture_url, 'https://openvibe.media/f/episode-pic.jpg');
    assert.deepStrictEqual(JSON.parse(stored.subject_json), { name: 'Maticus', handle: '@maticus', avatar: 'https://openvibe.media/o/med_maticus' });
    assert.ok(Math.abs(Number(stored.media_ratio) - 1200 / 630) < 1e-9);
    const fed = await (await t.get('/api/v1/feed?limit=20')).json();
    const sourceCard = fed.items.find((x) => x.id === 'p:3');
    assert.strictEqual(sourceCard.kind, 'rundown');
    assert.strictEqual(sourceCard.subject.handle, '@maticus');
    live.close();

    console.log('feed shape: Rundown kind/actor/mark/subject/image and recording duration_s/watch link ok');
    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
