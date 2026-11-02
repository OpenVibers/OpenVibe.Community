'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the roadmap and the pulse are a pick block, a row
 * of chips picks one of the two shelves, and the questions are a fold. Radio inputs and :has(), no script for the
 * chips; every shelf stays in the page for crawlers; a wider screen shows both shelves and no chips.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    try {
        // A roadmap item and a pulse item, so the home has something to show in its pick block.
        await t.db.prepare("INSERT INTO threads (space_id, slug, title, status, last_activity_at) VALUES (4, 'test-item', 'A test item', 'in_progress', ov_now())").run();
        await t.db.prepare("INSERT INTO pulse_items (source_service, source_type, source_id, title, url, origin, visibility, occurred_at) VALUES ('network', 'notice', 'n1', 'Something happened', 'https://openvibe.network/', 'system', 'public', ov_now())").run();

        await check('the roadmap and the pulse are chips: one per shelf, the first picked, every shelf in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(page.includes('<div class="pick" id="pick-happening">'), 'the pick block is on the home');
            const block = page.slice(page.indexOf('<div class="pick" id="pick-happening">'));
            const chips = [...block.matchAll(/<a class="pick-chip" href="#(?:pp-happening-)?([a-z-]+)">()([^<]+)<\/a>/g)];
            assert.deepStrictEqual(chips.map((m) => m[1]), ['shelf-roadmap', 'shelf-pulse'], 'a chip per shelf');
            assert.ok(!/type="radio"/.test(block), 'no chip is a radio: nothing is picked, every pane shows');
            const panes = [...block.matchAll(/<div class="pick-pane" id="([a-z-]+)">/g)].map((m) => m[1]);
            assert.deepStrictEqual(panes, ['shelf-roadmap', 'shelf-pulse'], 'every shelf is in the page, one per chip');
            // Nothing was removed: both shelves are still there.
            for (const title of ['On the roadmap', 'A test item', 'Across OpenVibe', 'Recently shipped on OpenVibe.Community']) {
                assert.ok(page.includes(title), `${title} is on the page`);
            }
        });

        await check('the CSS guard: the chips are hidden and both shelves show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'community.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
        });

        await check('the questions are a fold, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            assert.ok(r.text.includes('<details class="hm-fold hm-fold-block" id="faq-fold" open>'), 'the questions are a fold, open in the page');
            assert.ok(r.text.includes('document.getElementById("faq-fold")'), 'the fold has the script that closes it on a phone');
            // The questions stay in the page.
            assert.ok(r.text.includes('id="questions"'));
            assert.match(r.text, /<div class="cm-faq">/);
        });
    } finally {
        await t.close();
    }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
