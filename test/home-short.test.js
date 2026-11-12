'use strict';
/**
 * The home's lower half (the owner, 2026-11-10): the roadmap and "Across OpenVibe" are two plain sections, each row
 * with a mark at its start (a roadmap item's state as an icon; the site a thing happened on as an icon, beside the
 * person's picture where a person did it); one row a place; and the questions are all in the page, with a button
 * that opens the rest where a phone shows the first two.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    // The home's "Across OpenVibe" is the one feed's wall view (Network feed.item@1). A recorded wall
    // response stands in for Network: one row a place, a site mark, the AI label and its picture.
    const wall = { items: [
        { id: 'f:network:members:n1', source: { service: 'network', type: 'members', id: 'n1' }, title: '3 people joined today', url: 'https://openvibe.network/', origin: 'system', actor: null, occurred_at: new Date().toISOString() },
        { id: 'f:live:stream:s1', source: { service: 'live', type: 'stream', id: 's1' }, title: 'Dee went live: Raid night', url: 'https://openvibe.live/@Dee', origin: 'system', actor: null, occurred_at: new Date().toISOString() },
        { id: 'f:today:event:t1', source: { service: 'today', type: 'event', id: 't1' }, title: 'Live: Raid night', url: 'https://openvibe.live/@Dee', origin: 'system', actor: null, occurred_at: new Date().toISOString() },
        { id: 'f:blog:post:b1', source: { service: 'blog', type: 'post', id: 'b1' }, title: 'A new post', url: 'https://openvibe.blog/a-new-post', origin: 'ai', label: 'AI', actor: null,
            picture_url: 'https://openvibe.media/o/med_01JZ00000000000000000000B1', text: 'What changed this week, in one paragraph.', occurred_at: new Date().toISOString() },
    ] };
    const feedFetch = async (url) => ({ ok: true, status: 200, async text() { return JSON.stringify(String(url).includes('/wall') ? wall : { items: [], next_cursor: null }); } });
    const t = await boot({ appOpts: { feedFetch } });
    try {
        await t.db.prepare("INSERT INTO threads (space_id, slug, title, status, last_activity_at) VALUES (4, 'test-item', 'A test item', 'in_progress', ov_now())").run();
        await t.db.prepare("INSERT INTO threads (space_id, slug, title, status, last_activity_at) VALUES (4, 'done-item', 'A finished item', 'done', ov_now())").run();

        await check('the roadmap and the pulse are two sections, not a pick block', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('class="pick"') && !page.includes('pick-chip') && !page.includes('What is happening'), 'no chips and no extra heading over the two');
            assert.match(page, /<div class="cm-pair"><section class="cm-sec" id="roadmap" aria-labelledby="h-roadmap">/);
            assert.match(page, /<section class="cm-sec" id="pulse" aria-labelledby="h-pulse">/);
            for (const title of ['On the roadmap', 'A test item', 'Across OpenVibe', 'Recently shipped on OpenVibe.Community']) assert.ok(page.includes(title), `${title} is on the page`);
        });

        await check('a roadmap row: its state is the mark, and the word once under the title', async () => {
            const page = (await t.get('/')).text;
            const road = page.slice(page.indexOf('id="roadmap"'), page.indexOf('id="pulse"'));
            assert.match(road, /<span class="cm-mark cm-mark--accent" aria-hidden="true"><svg class="ovk-i"/, 'in progress: the accent mark');
            assert.match(road, /<span class="cm-mark cm-mark--ok" aria-hidden="true">/, 'done: the green mark');
            assert.match(road, /<span class="ovk-row-sub"><span>In progress<\/span>/);
            assert.ok(!/ovk-badge/.test(road), 'no badge repeated on every row');
        });

        await check('a thing that happened: the site as an icon, its words, its picture; one row a place', async () => {
            const page = (await t.get('/')).text;
            const rows = page.slice(page.indexOf('id="pulse"'), page.indexOf('id="api"'));
            assert.match(rows, /<span class="cm-mark cm-mark--site" aria-hidden="true">/, 'no person: the site alone');
            assert.match(rows, /<span class="ovk-row-sub"><span>Network<\/span>/, 'the site in words, with its capital');
            assert.strictEqual((rows.match(/href="https:\/\/openvibe\.live\/@Dee"/g) || []).length, 1, "a stream's go-live and its day's card are one row");
            assert.match(rows, /<span>Blog · What changed this week, in one paragraph\.<\/span>/, "the item's own line beside the site");
            assert.match(rows, /<img class="cm-pthumb" src="https:\/\/openvibe\.media\/o\/med_01JZ00000000000000000000B1[^"]*" alt="" width="44" height="44" loading="lazy"/, 'its picture at the end of the row');
            assert.match(rows, /ovk-badge[^>]*>AI</, 'what OpenVibe.AI wrote says so');
        });

        await check('the questions: all in the page, a mark and an arrow on each, and the button a phone opens the rest with', async () => {
            const page = (await t.get('/')).text;
            const q = page.slice(page.indexOf('id="questions"'));
            assert.strictEqual((q.slice(0, q.indexOf('</section>')).match(/<details>/g) || []).length, 6, 'six questions, none left out');
            assert.match(q, /<div class="cm-peek" id="faq-peek"><div class="cm-faq"><details><summary><span class="cm-faq-i" aria-hidden="true">/);
            assert.match(q, /<button type="button" class="cm-peek-more" id="faq-more" aria-controls="faq-peek" aria-expanded="false" hidden><span data-more="All 6 questions" data-less="Show fewer">All 6 questions<\/span>/);
            assert.ok(!page.includes('hm-fold'), 'the closed fold is gone');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'community.css'), 'utf8');
            assert.match(css, /\.cm-peek\[data-clamped\] \{ max-height: 150px;/, 'the list fades only once the script has clamped it');
            assert.ok(!/\.pick-|\.hm-fold/.test(css), 'the styles of the blocks that are gone went with them');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
