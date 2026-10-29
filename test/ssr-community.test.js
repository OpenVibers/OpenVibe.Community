'use strict';
/**
 * Server-rendered pages read from Community's own store (never from OpenVibe.Live), with the
 * same visibility rules as the API.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 } });
    const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);
    const svc = t.app.locals.pastes;
    const alex = t.network.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex', avatar_url: 'https://openvibe.media/avatars/alex.png' });
    const token = t.network.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex' });
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    const anon = { kind: 'anonymous', subject: null, staff: false, origin: 'user' };

    const js = (await svc.createText(asAlex, { title: 'Hello world in JavaScript', content: 'const greet = (name) => `Hi ${name}`;\n', language: 'javascript' })).slug;
    const nginx = (await svc.createText(anon, { title: 'nginx snippet', content: 'server {\n  listen 80;\n}\n', language: 'nginx' })).slug;
    const py = (await svc.createText(asAlex, { title: 'python helper', content: 'def add(a, b):\n    return a + b\n', language: 'python' })).slug;
    const unl = (await svc.createText(asAlex, { title: 'secret notes', content: 'unlisted <script>alert(1)</script>', visibility: 'unlisted' })).slug;
    const priv = (await svc.createText(asAlex, { title: 'private thing', content: 'private', visibility: 'private' })).slug;
    const burn = (await svc.createText(asAlex, { title: 'burn me', content: 'once only', burn_after_read: true })).slug;
    await t.db.prepare('UPDATE pastes SET views = 900 WHERE slug = ?').run(nginx);
    await t.db.prepare("INSERT INTO pastes (slug, owner_subject, type, title, content, screenshot_url) VALUES ('fair-moon-23', ?, 'screenshot', 'Desktop shot', 'my desktop', 'https://openvibe.media/f/abc-desk.png')").run(alex.subject_id);

    await check('home: latest + most viewed come from the store; nothing hidden; Live is never asked', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        has(r.text, `href="/p/${js}"`);
        // The most viewed are the home's quick filter (/pastes?sort=views), read from the same store.
        has(r.text, 'href="/pastes?sort=views"');
        const views = await t.get('/pastes?sort=views');
        assert.ok(views.text.indexOf(nginx) > 0 && views.text.indexOf(nginx) < views.text.indexOf(js), 'most viewed first');
        assert.ok(![r.text, views.text].some((html) => html.includes(unl) || html.includes(priv)));
        assert.strictEqual(t.live.calls.filter((c) => c.path.startsWith('/api/pastes')).length, 0);
    });

    await check('paste page: rendered from the store, view counted, author from the projection', async () => {
        const r = await t.get(`/p/${js}`, { headers: { 'x-forwarded-for': '198.51.100.20' } });
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>Hello world in JavaScript · OpenVibe.Community</title>');
        has(r.text, 'class="hljs-keyword">const</span>');
        has(r.text, '<div class="code-wrap" data-code tabindex="0" role="region" aria-label="Paste content">');
        const ld = r.text.match(/<script type="application\/ld\+json">(.*?)<\/script>/g).map((s) => JSON.parse(s.replace(/<script[^>]*>|<\/script>/g, '')));
        assert.strictEqual(ld.find((o) => o['@type'] === 'Article').author.name, 'Alex');
        has(r.text, 'https://openvibe.media/avatars/alex.png');
        assert.strictEqual((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get(js)).views, 1);
        assert.ok(!r.text.includes(`data-delete="${js}"`), 'no delete button for visitors');
    });

    await check('unlisted: noindex and escaped; private: 404 for visitors, the owner gets the page and delete', async () => {
        const u = await t.get(`/p/${unl}`);
        has(u.text, '<meta name="robots" content="noindex,follow">');
        has(u.text, '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.ok(!u.text.includes('<script>alert(1)</script>'));
        assert.strictEqual((await t.get(`/p/${priv}`)).status, 404);
        const owner = await t.get(`/p/${priv}`, { cookies: [`ov_token=${token}`] });
        assert.strictEqual(owner.status, 200);
        has(owner.text, `data-delete="${priv}"`);
        // A service token is no identity on a page.
        const svcTok = t.network.signService({ cap: ['community.paste.write', 'community.paste.moderate'] });
        assert.strictEqual((await t.get(`/p/${priv}`, { headers: { authorization: `Bearer ${svcTok}`, 'x-ov-subject': alex.subject_id, 'x-ov-staff': '1' } })).status, 404);
    });

    await check('burn after read: the first visitor sees it, the next gets the 410 page', async () => {
        assert.strictEqual((await t.get(`/p/${burn}`, { headers: { 'x-forwarded-for': '198.51.100.30' } })).status, 200);
        const gone = await t.get(`/p/${burn}`, { headers: { 'x-forwarded-for': '198.51.100.31' } });
        assert.strictEqual(gone.status, 410);
        has(gone.text, 'This paste has burned');
    });

    await check('download reads the store without a view; screenshots use the stored Media URL', async () => {
        const before = (await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get(py)).views;
        const dl = await t.get(`/p/${py}/download`);
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(dl.headers.get('content-disposition'), `attachment; filename="${py}.py"`);
        assert.ok(dl.text.startsWith('def add'));
        assert.strictEqual((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get(py)).views, before);
        const shot = await t.get('/p/fair-moon-23');
        has(shot.text, '<meta property="og:image" content="https://openvibe.media/f/abc-desk.png">');
        const dls = await t.get('/p/fair-moon-23/download');
        assert.strictEqual(dls.headers.get('location'), 'https://openvibe.media/f/abc-desk.png');
    });

    await check('browse: search, views sort and language filter over the store', async () => {
        const q = await t.get('/pastes?q=nginx');
        has(q.text, `href="/p/${nginx}"`);
        assert.ok(!q.text.includes(`href="/p/${js}"`));
        const views = await t.get('/pastes?sort=views');
        const res = views.text.slice(views.text.indexOf('id="results"'));
        assert.ok(res.indexOf(nginx) < res.indexOf(js));
        const lang = await t.get('/pastes?lang=python');
        has(lang.text, `href="/p/${py}"`);
        assert.ok(!lang.text.includes(`href="/p/${js}"`));
    });

    await check('a Markdown paste reads as a document, its source a click away; code pastes are unchanged', async () => {
        const doc = (await svc.createText(anon, { title: 'Notes', content: '# Notes!\n\n### Part\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n- x\n  - y\n\n<script>alert(1)</script>', language: 'markdown' })).slug;
        const r = await t.get(`/p/${doc}`);
        assert.strictEqual(r.status, 200);
        // Its opening # only repeats the title (the page's h1), so it is left out and ### leads at h2.
        has(r.text, '<div class="md paste-doc"><h2>Part</h2>');
        const other = (await svc.createText(anon, { title: 'Release', content: '# Something else\n\ntext', language: 'markdown' })).slug;
        has((await t.get(`/p/${other}`)).text, '<div class="md paste-doc"><h2>Something else</h2>');
        has(r.text, '<td class="al-r">2</td>');
        has(r.text, '<li>x<ul><li>y</li></ul></li>');
        has(r.text, '<details class="paste-source">');
        has(r.text, '<div class="code-wrap wrap" data-code tabindex="0" role="region" aria-label="Markdown source">');
        assert.ok(!r.text.includes('<script>alert(1)</script>'), 'raw HTML stays text');
        const code = await t.get(`/p/${js}`);
        assert.ok(!code.text.includes('paste-doc') && code.text.includes('<div class="code-wrap" data-code'), 'code: no document, no default wrap');
    });

    await check('a link that picked up trailing punctuation (**, a full stop, a bracket) redirects to the paste', async () => {
        for (const [path, to] of [
            [`/p/${js}**`, `/p/${js}`],
            [`/p/${js}.`, `/p/${js}`],
            [`/p/${js})`, `/p/${js}`],
            [`/p/${js}%2A%2A`, `/p/${js}`],
            [`/p/${js}),/raw?dl=1`, `/p/${js}/raw?dl=1`],
            [`/p/${js}./download`, `/p/${js}/download`],
        ]) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 301, path);
            assert.strictEqual(r.headers.get('location'), to, path);
        }
        // Nothing left to point at, or junk in the middle: still "Paste not found".
        assert.strictEqual((await t.get('/p/**')).status, 404);
        assert.strictEqual((await t.get(`/p/${js.slice(0, 4)}*${js.slice(4)}`)).status, 404);
        assert.strictEqual((await t.get(`/p/${js}`)).status, 200);
    });

    await check('/my lists the signed-in person\'s pastes, private and unlisted included', async () => {
        const mine = await t.get('/my', { cookies: [`ov_token=${token}`] });
        assert.strictEqual(mine.status, 200);
        for (const slug of [js, py, unl, priv]) has(mine.text, `href="/p/${slug}"`);
        assert.ok(!mine.text.includes(nginx));
    });

    await check('no-JS form creates in the store as the signed-in subject; anonymous posts share the 20/10min budget', async () => {
        const body = new URLSearchParams({ title: 'via form', language: 'python', content: 'print(1)', visibility: 'private' }).toString();
        const post = await t.get('/new', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: [`ov_token=${token}`] });
        assert.strictEqual(post.status, 303);
        const slug = post.headers.get('location').replace('/p/', '');
        const row = await t.db.prepare('SELECT owner_subject, visibility FROM pastes WHERE slug = ?').get(slug);
        assert.deepStrictEqual(row, { owner_subject: alex.subject_id, visibility: 'private' });
        const anonBody = new URLSearchParams({ content: 'hi' }).toString();
        const ip = '203.0.113.200';
        for (let i = 0; i < 20; i++) {
            const r = await t.get('/new', { method: 'POST', body: anonBody, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip } });
            assert.strictEqual(r.status, 303, `#${i}`);
        }
        const over = await t.get('/new', { method: 'POST', body: anonBody, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip } });
        assert.strictEqual(over.status, 429);
        has(over.text, 'Too many anonymous posts');
        const api = await t.get('/api/pastes', { method: 'POST', body: JSON.stringify({ content: 'x' }), headers: { 'content-type': 'application/json', 'x-forwarded-for': ip } });
        assert.strictEqual(api.status, 429, 'the API shares the budget');
    });

    await check('feed and sitemap list store pastes', async () => {
        const feed = await t.get('/feed.xml');
        has(feed.text, `/p/${js}`);
        assert.ok(!feed.text.includes(priv));
        const map = await t.get('/sitemap.xml');
        has(map.text, `/p/${js}`);
        assert.ok(!map.text.includes(unl) && !map.text.includes(priv));
    });

    await t.close();
    done();
})();
