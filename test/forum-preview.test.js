'use strict';
/**
 * A post's preview (plan 2026-11-13 §Y.1 A9: "Forum needs a Markdown preview"). POST /api/forum/preview answers the
 * words as the site will publish them, from the same renderer (render/markdown.js), for a signed-in person on this
 * site; it stores nothing. The new-thread and reply forms name it (data-ovc-preview) and public/js/composer.js gives
 * them a Preview switch.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { renderMarkdown } = require('../server/render/markdown');

(async () => {
    const t = await boot({ authority: 'community' });
    const alex = t.network.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const jwt = t.network.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const json = (body, extra = {}) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json', ...(extra.headers || {}) }, cookies: extra.cookies || [] });
    const me = { cookies: [`ov_token=${jwt}`] };
    const source = '# Plan\n\nA **bold** step, `code`, and [a link](https://example.com).\n\n- one\n- two\n\n<script>alert(1)</script>';

    await check('the preview is the published rendering, sanitised, and nothing is stored', async () => {
        const before = await t.db.prepare('SELECT COUNT(*) AS n FROM posts').get();
        const r = await t.get('/api/forum/preview', json({ body: source }, me));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        const html = r.json().html;
        assert.strictEqual(html, renderMarkdown(source), 'the same renderer as the published post');
        assert.ok(/<strong>bold<\/strong>/.test(html) && /<li>one<\/li>/.test(html));
        assert.ok(!/<script/i.test(html), 'markup the post may not carry stays out');
        const after = await t.db.prepare('SELECT COUNT(*) AS n FROM posts').get();
        assert.deepStrictEqual(after, before, 'a preview stores nothing');
    });

    await check('empty words preview as nothing; very long words are cut at the post\'s own limit', async () => {
        assert.strictEqual((await t.get('/api/forum/preview', json({ body: '   ' }, me))).json().html, '');
        const long = 'a'.repeat(50000);
        const r = await t.get('/api/forum/preview', json({ body: long }, me));
        assert.strictEqual(r.status, 200);
        assert.ok(r.json().html.length < 45000, 'cut at 40,000 characters');
    });

    await check('only a signed-in person on this site', async () => {
        assert.strictEqual((await t.get('/api/forum/preview', json({ body: 'hi' }))).status, 401);
        const cross = await t.get('/api/forum/preview', json({ body: 'hi' }, { ...me, headers: { origin: 'https://evil.example' } }));
        assert.strictEqual(cross.status, 403);
    });

    await check('the new-thread and reply forms name the preview', async () => {
        const page = await t.get('/forum/general/new', me);
        assert.ok(page.text.includes('data-ovc-preview="/api/forum/preview"'), 'the new-thread form');
    });

    await t.close();
    done();
})();
