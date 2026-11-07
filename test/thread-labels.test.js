'use strict';
/**
 * Content labels on threads (L1, labels and choices; Contracts common.content-labels@1): the author labels a thread as
 * they post it or later, a moderator may too, and nobody else; the lists and the thread page carry data-ov-labels (Shared's
 * ov-labels.js applies each reader's own choice) with the author named so they always see their own, the thread's own
 * page is "opened" (a hide covers instead of emptying it), the labels show in words, and ticking nothing clears them.
 *   node test/thread-labels.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const ui = require('../server/render/labels');

// ── The render helpers ──────────────────────────────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(ui.inForce({ content_labels: { labels: ['nudity', '18+', 'gore'], suggested: ['language'] } }), ['nudity', '18+']);
assert.deepStrictEqual(ui.inForce({ content_labels: '{"labels":["spoilers"],"suggested":[]}' }), ['spoilers'], 'a jsonb string');
assert.deepStrictEqual(ui.inForce({}), []);
assert.strictEqual(ui.attrs([]), '');
assert.strictEqual(ui.attrs(['18+'], { owner: 'usr_01ABC', opened: true }), ' data-ov-labels="18+" data-ov-labels-owner="usr_01ABC" data-ov-labels-opened');
assert.strictEqual(ui.attrs(['18+'], { owner: 'bad owner' }), ' data-ov-labels="18+"', 'no owner that is not a subject');
assert.ok(ui.chips(['language', '18+']).includes('<li class="ovk-label ovk-label--adult" data-label="18+">18+</li>'));
const pick = ui.picker({ current: ['nudity'], suggested: ['flashing', 'nudity'] });
assert.strictEqual((pick.match(/name="labels" value="/g) || []).length, 6);
assert.ok(pick.includes('value="nudity" checked>') && !pick.includes('value="flashing" checked'), 'a suggestion is never ticked');
assert.strictEqual((pick.match(/class="ovl-sug">Suggested</g) || []).length, 1);
assert.strictEqual(ui.fromForm({}), undefined);
assert.deepStrictEqual(ui.fromForm({ labels_form: '1' }), []);
assert.deepStrictEqual(ui.fromForm({ labels_form: '1', labels: 'spoilers' }), ['spoilers']);
assert.strictEqual(ui.fromForm({ labels_form: '1', labels: ['gore'] }), null);

/** A form body with repeated fields: [['labels', 'nudity'], ['labels', '18+'], …]. */
const form = (pairs) => ({ method: 'POST', body: new URLSearchParams(pairs).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    // Feedback in the feed style (render/forum.js); General stays a forum board (render/board.js).
    await t.db.prepare("UPDATE spaces SET style = 'feed' WHERE slug = 'feedback'").run();
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const as = (jwt, opts = {}) => ({ ...opts, cookies: [`ov_token=${jwt}`] });
    try {
        let boardUrl;
        let feedUrl;
        await check('the new-thread form has the picker, and a thread is posted with its labels', async () => {
            const page = await t.get('/forum/general/new', as(alexJwt));
            assert.ok(page.text.includes('<legend>Content labels</legend>') && page.text.includes('name="labels_form"'), 'the picker');
            assert.ok(/<link rel="stylesheet" href="\/css\/labels\.css(\?v=[0-9a-f]+)?">/.test(page.text), 'its sheet');
            let r = await t.get('/forum/general/new', as(alexJwt, form([['title', 'Finale talk'], ['body', 'The last episode.'], ['labels_form', '1'], ['labels', 'spoilers'], ['labels', '18+']])));
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            boardUrl = new URL(r.headers.get('location'), 'https://x').pathname;
            r = await t.get('/forum/feedback/new', as(alexJwt, form([['title', 'Flashing intro'], ['body', 'The intro strobes.'], ['labels_form', '1'], ['labels', 'flashing']])));
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            feedUrl = new URL(r.headers.get('location'), 'https://x').pathname;
            r = await t.get('/forum/general/new', as(alexJwt, form([['title', 'Bad label'], ['body', 'x'], ['labels_form', '1'], ['labels', 'gore']])));
            assert.strictEqual(r.status, 400, 'not a label');
            assert.ok(r.text.includes('Labels are from this list'), r.text.slice(0, 200));
        });

        await check('the board: the row is labelled, its title cell is what a blur covers, the chips under the title', async () => {
            const r = await t.get('/forum/general');
            assert.ok(r.text.includes(` data-ov-labels="spoilers,18+" data-ov-labels-owner="${alex.subject_id}">`), 'the row');
            assert.ok(r.text.includes('<td class="topic-main" data-ov-labels-media>'), 'the cover goes on the title cell');
            assert.ok(r.text.includes('<li class="ovk-label" data-label="spoilers">Spoilers</li><li class="ovk-label ovk-label--adult" data-label="18+">18+</li>'), 'in words');
        });

        await check('the thread page: chips, the posts labelled and opened, the Labels box for the author only', async () => {
            let r = await t.get(boardUrl);
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes(`<div class="postbits" data-ov-labels="spoilers,18+" data-ov-labels-owner="${alex.subject_id}" data-ov-labels-opened>`), 'the posts');
            assert.ok(!r.text.includes('id="labels"') && !r.text.includes('css/labels.css'), 'no box for a reader');
            r = await t.get(boardUrl, as(samJwt));
            assert.ok(!r.text.includes('id="labels"'), 'nor for someone else');
            r = await t.get(boardUrl, as(alexJwt));
            assert.ok(/<details class="labels-box" id="labels"><summary>[\s\S]*<span class="labels-box-line">Spoilers, 18\+<\/span>/.test(r.text), 'the box says what is set');
            assert.ok(r.text.includes('css/labels.css'), 'with its sheet');
            r = await t.get(feedUrl);
            assert.ok(r.text.includes(`<div class="posts" data-ov-labels="flashing" data-ov-labels-owner="${alex.subject_id}" data-ov-labels-opened>`), 'the feed style too');
            r = await t.get('/forum/feedback');
            assert.ok(/<li class="thread-row[^"]*" data-ov-labels="flashing" data-ov-labels-owner="/.test(r.text), 'and its list');
        });

        await check('only the author or a moderator labels; ticking nothing clears them; the API says so too', async () => {
            let r = await t.get(`${boardUrl}/labels`, as(samJwt, form([['labels_form', '1'], ['labels', 'nudity']])));
            assert.strictEqual(r.status, 403, 'someone else');
            r = await t.get(`${boardUrl}/labels`, as(alexJwt, form([['labels_form', '1'], ['labels', 'spoilers']])));
            assert.strictEqual(r.status, 303);
            assert.ok((await t.get(boardUrl)).text.includes(' data-ov-labels="spoilers" '), 'now spoilers only');
            r = await t.get(`${boardUrl}/labels`, as(alexJwt, form([['labels_form', '1']])));
            assert.strictEqual(r.status, 303);
            assert.ok(!(await t.get(boardUrl)).text.includes('data-ov-labels='), 'cleared');
            const slug = boardUrl.split('/').pop();
            r = await t.get(`/api/v1/spaces/general/threads/${slug}/labels`, as(alexJwt, { method: 'PUT', body: JSON.stringify({ labels: ['graphic'] }), headers: { 'content-type': 'application/json' } }));
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json().thread.content_labels, { labels: ['graphic'], suggested: [] });
            r = await t.get(`/api/v1/spaces/general/threads/${slug}/labels`, as(alexJwt, { method: 'PUT', body: JSON.stringify({ labels: ['gore'] }), headers: { 'content-type': 'application/json' } }));
            assert.strictEqual(r.status, 400);
            assert.strictEqual(r.json().code, 'thread.labels_invalid');
            r = await t.get(`/api/v1/spaces/general/threads/${slug}/labels`, as(samJwt, { method: 'PUT', body: JSON.stringify({ labels: [] }), headers: { 'content-type': 'application/json' } }));
            assert.strictEqual(r.status, 403);
        });

        await check('a confirmed suggestion leaves the suggestions; an unlabelled thread carries the empty shape', async () => {
            const slug = feedUrl.split('/').pop();
            await t.db.prepare(`UPDATE threads SET content_labels = '{"labels":["flashing"],"suggested":["language","graphic"]}'::jsonb WHERE slug = ?`).run(slug);
            let r = await t.get(feedUrl, as(alexJwt));
            assert.ok(/value="language"><span class="ovl-card"><b>Strong language<\/b><small>[^<]+<\/small><em class="ovl-sug">Suggested<\/em>/.test(r.text), 'marked, not ticked');
            r = await t.get(`/api/v1/spaces/feedback/threads/${slug}/labels`, as(alexJwt, { method: 'PUT', body: JSON.stringify({ labels: ['flashing', 'language'] }), headers: { 'content-type': 'application/json' } }));
            assert.deepStrictEqual(r.json().thread.content_labels, { labels: ['flashing', 'language'], suggested: ['graphic'] });
            r = await t.get('/api/v1/spaces/general/threads', as(alexJwt));
            const plain = (r.json().threads || r.json().items || []).find((x) => x.title !== 'Finale talk');
            if (plain) assert.deepStrictEqual(plain.content_labels, { labels: [], suggested: [] });
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
