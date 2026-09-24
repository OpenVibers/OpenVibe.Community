'use strict';
/** Server-rendered pages: home, browse, paste (SEO head + body), my, new, errors. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);

    await check('home renders hero, latest + trending pastes, CTA and roadmap with full SEO head', async () => {
        const r = await t.get('/');
        assert.strictEqual(r.status, 200);
        has(r.text, '<html lang="en"');
        has(r.text, '<title>OpenVibe.Community — the people of OpenVibe</title>');
        has(r.text, '<link rel="canonical" href="https://openvibe.community/">');
        has(r.text, '<meta property="og:type" content="website">');
        has(r.text, '<meta name="twitter:card" content="summary">');
        has(r.text, '"@type":"WebSite"');
        has(r.text, '/shared/theme-loader.js?v=');
        has(r.text, '/shared/navbar.js?v=');
        has(r.text, '/shared/footer.js?v=');
        has(r.text, '<h1>Share it with a link. Talk about it here.</h1>');
        has(r.text, '<h2>Latest pastes</h2>');
        has(r.text, '<h2>Most viewed</h2>');
        has(r.text, 'id="spaces"');
        has(r.text, 'href="/p/amber-fox-42"');
        // Most-viewed puts the 900-view nginx paste first.
        const trendingAt = r.text.indexOf('id="trending"');
        assert.ok(r.text.indexOf('blue-lake-17', trendingAt) < r.text.indexOf('amber-fox-42', trendingAt));
        // Unlisted/private fixtures never show on shared pages.
        assert.ok(!r.text.includes('dark-owl-55') && !r.text.includes('grim-vale-61'));
        // Navbar/footer init payload matches the shared-chrome contract.
        const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.service, 'community');
        assert.deepStrictEqual(cfg.navbar.links.map((l) => l.href), ['/pastes', '/s', '/pulse', '/new']);
        assert.strictEqual(cfg.navbar.menu.after[0].href, '/my');
        assert.strictEqual(cfg.navbar.history.type, 'page');
        assert.strictEqual(cfg.navbar.silentLogin, 'https://openvibe.community/auth/login?silent=1&next={url}');
        assert.strictEqual(cfg.footer.mount, '#ov-footer');
        assert.strictEqual(cfg.footer.variant, 'full');
        // Verbiage: never "free"/"no cost".
        assert.ok(!/\bfree\b(?! speech)/i.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'no "free" claims outside "free speech"');
    });

    await check('paste page: SEO head, Article JSON-LD with author/datePublished, highlighted body, actions, related', async () => {
        const r = await t.get('/p/amber-fox-42');
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>Hello world in JavaScript · OpenVibe.Community</title>');
        has(r.text, '<link rel="canonical" href="https://openvibe.community/p/amber-fox-42">');
        has(r.text, '<meta name="robots" content="index,follow">');
        has(r.text, '<meta property="og:type" content="article">');
        has(r.text, 'article:published_time');
        const ld = r.text.match(/<script type="application\/ld\+json">(.*?)<\/script>/g).map((s) => JSON.parse(s.replace(/<script[^>]*>|<\/script>/g, '')));
        const article = ld.find((o) => o['@type'] === 'Article');
        assert.ok(article, 'Article JSON-LD present');
        assert.strictEqual(article.author.name, 'Alex');
        assert.strictEqual(article.datePublished, '2026-09-15T10:00:00.000Z');
        assert.strictEqual(article.hasPart.programmingLanguage, 'javascript');
        assert.ok(ld.some((o) => o['@type'] === 'BreadcrumbList'));
        has(r.text, 'class="hljs-keyword">const</span>', 'server-side highlighted');
        has(r.text, 'href="/p/amber-fox-42/raw"');
        has(r.text, 'href="/p/amber-fox-42/download"');
        has(r.text, 'data-copy-content="amber-fox-42"');
        has(r.text, 'twitter.com/intent/tweet');
        has(r.text, '<h2>More like this</h2>');
        has(r.text, 'https://openvibe.live/data/avatars/alex.png', 'relative Live avatar made absolute');
        const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.history.type, 'paste');
        assert.strictEqual(cfg.navbar.history.title, 'Hello world in JavaScript');
        assert.strictEqual(cfg.footer.variant, 'compact');
        // The view was counted by Live (the SSR fetch had no no_view flag).
        const call = t.live.calls.find((c) => c.path === '/api/pastes/amber-fox-42');
        assert.strictEqual(call.query.no_view, undefined);
    });

    await check('unlisted paste is noindex and its content is escaped', async () => {
        const r = await t.get('/p/dark-owl-55');
        assert.strictEqual(r.status, 200);
        has(r.text, '<meta name="robots" content="noindex,follow">');
        has(r.text, '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.ok(!r.text.includes('<script>alert(1)</script>'));
    });

    await check('screenshot paste uses the Media image as og:image and ImageObject JSON-LD', async () => {
        const r = await t.get('/p/fair-moon-23');
        has(r.text, '<meta property="og:image" content="https://openvibe.media/p/fair-moon-23/screenshot">');
        has(r.text, '<meta name="twitter:card" content="summary_large_image">');
        has(r.text, '"@type":"ImageObject"');
        has(r.text, '<img src="https://openvibe.media/p/fair-moon-23/screenshot"');
    });

    await check('private paste 404s for anonymous visitors and renders for its owner', async () => {
        const anon = await t.get('/p/grim-vale-61');
        assert.strictEqual(anon.status, 404);
        has(anon.text, 'Paste not found');
        const token = t.network.sign({ id: 7, username: 'alex', display_name: 'Alex' });
        const owner = await t.get('/p/grim-vale-61', { cookies: [`ov_token=${token}`] });
        assert.strictEqual(owner.status, 200);
        has(owner.text, 'data-delete="grim-vale-61"', 'owner sees delete');
        const call = t.live.calls.filter((c) => c.path === '/api/pastes/grim-vale-61').pop();
        assert.strictEqual(call.headers.authorization, `Bearer ${token}`, 'visitor token forwarded to Live');
    });

    await check('raw / screenshot bounce to Media; download serves the text as an attachment without a view', async () => {
        const raw = await t.get('/p/amber-fox-42/raw');
        assert.strictEqual(raw.status, 302);
        assert.strictEqual(raw.headers.get('location'), 'https://openvibe.media/p/amber-fox-42/raw');
        const shot = await t.get('/p/fair-moon-23/screenshot');
        assert.strictEqual(shot.headers.get('location'), 'https://openvibe.media/p/fair-moon-23/screenshot');
        const dl = await t.get('/p/amber-fox-42/download');
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(dl.headers.get('content-disposition'), 'attachment; filename="amber-fox-42.js"');
        assert.ok(dl.text.startsWith('const greet'));
        const call = t.live.calls.filter((c) => c.path === '/api/pastes/amber-fox-42').pop();
        assert.strictEqual(call.query.no_view, '1');
    });

    await check('browse: search passes through to Live, views sort and language filter work, search pages are noindex', async () => {
        const all = await t.get('/pastes');
        assert.strictEqual(all.status, 200);
        has(all.text, '<link rel="canonical" href="https://openvibe.community/pastes">');
        has(all.text, 'href="/p/blue-lake-17"');
        const q = await t.get('/pastes?q=nginx');
        has(q.text, '<meta name="robots" content="noindex,follow">');
        has(q.text, 'href="/p/blue-lake-17"');
        assert.ok(!q.text.includes('href="/p/amber-fox-42"'));
        const call = t.live.calls.filter((c) => c.path === '/api/pastes' && c.query.search).pop();
        assert.strictEqual(call.query.search, 'nginx');
        const views = await t.get('/pastes?sort=views');
        const res = views.text.slice(views.text.indexOf('id="results"'));
        assert.ok(res.indexOf('blue-lake-17') < res.indexOf('amber-fox-42') && res.indexOf('amber-fox-42') < res.indexOf('cold-ridge-88'));
        const py = await t.get('/pastes?lang=python');
        has(py.text, 'href="/p/cold-ridge-88"');
        assert.ok(!py.text.includes('href="/p/amber-fox-42"'));
        has(py.text, '<option value="python" selected>');
        const old = await t.get('/pastes/amber-fox-42');
        assert.strictEqual(old.status, 301);
    });

    await check('/my redirects anonymous visitors to sign-in and lists the signed-in user\'s pastes (incl. unlisted/private)', async () => {
        const anon = await t.get('/my');
        assert.strictEqual(anon.status, 302);
        assert.strictEqual(anon.headers.get('location'), '/auth/login?next=%2Fmy');
        const token = t.network.sign({ id: 7, username: 'alex', display_name: 'Alex' });
        const mine = await t.get('/my', { cookies: [`ov_token=${token}`] });
        assert.strictEqual(mine.status, 200);
        has(mine.text, '<meta name="robots" content="noindex,nofollow">');
        for (const slug of ['amber-fox-42', 'cold-ridge-88', 'dark-owl-55', 'grim-vale-61']) has(mine.text, `href="/p/${slug}"`);
        assert.ok(!mine.text.includes('blue-lake-17'));
        const call = t.live.calls.filter((c) => c.path === '/api/pastes/by-user/alex').pop();
        assert.strictEqual(call.headers.authorization, `Bearer ${token}`);
    });

    await check('/new renders the form (private option only when signed in) and the no-JS post creates through Live', async () => {
        const anon = await t.get('/new');
        assert.strictEqual(anon.status, 200);
        has(anon.text, 'name="content"');
        assert.ok(!anon.text.includes('value="private"'));
        const token = t.network.sign({ id: 7, username: 'alex', display_name: 'Alex' });
        const signed = await t.get('/new?fork=amber-fox-42', { cookies: [`ov_token=${token}`] });
        has(signed.text, 'value="private"');
        has(signed.text, 'Fork of Hello world in JavaScript');
        const body = new URLSearchParams({ title: 'via form', language: 'python', content: 'print(1)', visibility: 'public' }).toString();
        const post = await t.get('/new', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: [`ov_token=${token}`] });
        assert.strictEqual(post.status, 303);
        assert.strictEqual(post.headers.get('location'), '/p/new-paste-99');
        const call = t.live.calls.filter((c) => c.method === 'POST' && c.path === '/api/pastes').pop();
        assert.strictEqual(call.headers.authorization, `Bearer ${token}`);
        assert.deepStrictEqual(JSON.parse(call.body.toString()).content, 'print(1)');
        const empty = await t.get('/new', { method: 'POST', body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.strictEqual(empty.status, 400);
        has(empty.text, 'content is empty');
        const limited = await t.get('/new', { method: 'POST', body: new URLSearchParams({ title: 'slow down', content: 'x' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.strictEqual(limited.status, 429);
        has(limited.text, 'Please wait 30s');
    });

    await check('404 page and API 404 JSON; health', async () => {
        const r = await t.get('/nope');
        assert.strictEqual(r.status, 404);
        has(r.text, 'Page not found');
        const a = await t.get('/api/nope');
        assert.strictEqual(a.status, 404);
        assert.deepStrictEqual(a.json(), { error: 'Not found' });
        assert.strictEqual((await t.get('/api/health')).json().service, 'openvibe-community');
    });

    await t.close();
    done();
})();
