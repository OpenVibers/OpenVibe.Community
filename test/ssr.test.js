'use strict';
/** Server-rendered pages: home, browse, paste (SEO head + body), my, new, errors — read from Community's own store. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0 } });
    const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);
    const alex = t.network.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex', avatar_url: '/data/avatars/alex.png' });
    const sam = t.network.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    await t.db.prepare('INSERT INTO subject_projection (subject_id, username, display_name, avatar_url) VALUES (?, ?, ?, ?)').run(alex.subject_id, 'alex', 'Alex', '/data/avatars/alex.png');
    await t.db.prepare('INSERT INTO subject_projection (subject_id, username, display_name, avatar_url) VALUES (?, ?, ?, ?)').run(sam.subject_id, 'sam', 'Sam', null);
    const ins = t.db.prepare(`INSERT INTO pastes (slug, owner_subject, type, title, content, language, visibility, screenshot_url, views, likes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    await ins.run('amber-fox-42', alex.subject_id, 'paste', 'Hello world in JavaScript', 'const greet = (name) => {\n  return `Hello, ${name}!`;\n};\nconsole.log(greet("OpenVibe"));\n', 'javascript', 'public', null, 120, 3, '2026-09-15 10:00:00', '2026-09-15 10:00:00');
    await ins.run('blue-lake-17', sam.subject_id, 'paste', 'nginx snippet', 'server {\n  listen 80;\n}\n', 'nginx', 'public', null, 900, 0, '2026-09-14 09:00:00', '2026-09-14 09:00:00');
    await ins.run('cold-ridge-88', alex.subject_id, 'paste', 'python helper', 'def add(a, b):\n    return a + b\n', 'python', 'public', null, 15, 1, '2026-09-13 08:00:00', '2026-09-13 08:00:00');
    await ins.run('dark-owl-55', alex.subject_id, 'paste', 'secret notes', 'unlisted <script>alert(1)</script>', 'text', 'unlisted', null, 2, 0, '2026-09-12 08:00:00', '2026-09-12 08:00:00');
    await ins.run('fair-moon-23', sam.subject_id, 'screenshot', 'Desktop shot', 'my desktop', 'text', 'public', 'https://openvibe.media/o/med_FAIRMOON', 40, 0, '2026-09-11 08:00:00', '2026-09-11 08:00:00');
    await ins.run('grim-vale-61', alex.subject_id, 'paste', 'private thing', 'private', 'text', 'private', null, 0, 0, '2026-09-10 08:00:00', '2026-09-10 08:00:00');

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
        has(r.text, '<h1>Share it with a link.<span class="sc-accent"> Talk about it here.</span></h1>');
        has(r.text, '/shared/showcase.css?v=');
        has(r.text, 'id="api"');
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
        assert.deepStrictEqual(cfg.navbar.links.map((l) => l.href), ['/pastes', '/s', '/pulse', '/search', '/new']);
        assert.strictEqual(cfg.navbar.menu.after[0].href, '/my');
        assert.strictEqual(cfg.navbar.history.type, 'page');
        assert.strictEqual(cfg.navbar.silentLogin, 'https://openvibe.community/auth/login?silent=1&next={url}');
        assert.strictEqual(cfg.navbar.loginUrl, '/auth/login?next={path}', 'sign-in returns to the current page (boost moves between pages)');
        assert.strictEqual(cfg.footer.mount, '#ov-footer');
        assert.strictEqual(cfg.footer.variant, 'full');
        // Verbiage: never "free"/"no cost".
        assert.ok(!/\bfree\b(?! speech)/i.test(r.text.replace(/<script[\s\S]*?<\/script>/g, '')), 'no "free" claims outside "free speech"');
    });

    await check('every page carries the boost marker and script, and the navbar signs in back to the current page', async () => {
        for (const url of ['/', '/pastes', '/new', '/p/amber-fox-42']) {
            const r = await t.get(url);
            assert.strictEqual(r.status, 200, url);
            assert.match(r.text, /<meta name="ov-boost" content="community@[^"]+">/, `${url}: the boost marker`);
            assert.match(r.text, /<script src="\/shared\/boost\.js\?v=[^"]+" data-main="#main" defer><\/script>/, `${url}: the boost script, main = #main`);
            assert.ok(r.text.includes('"loginUrl":"/auth/login?next={path}"'), `${url}: the navbar's login template`);
            assert.ok(r.text.includes('<main id="main"'), `${url}: the swappable main`);
        }
    });

    await check('paste page: SEO head, Article JSON-LD with author/datePublished, highlighted body, actions, related', async () => {
        const before = (await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views;
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
        has(r.text, 'https://openvibe.live/data/avatars/alex.png', 'relative avatar made absolute against Live');
        const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.history.type, 'paste');
        assert.strictEqual(cfg.navbar.history.title, 'Hello world in JavaScript');
        assert.strictEqual(cfg.footer.variant, 'compact');
        assert.ok((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views >= before, 'views are counted (deduped per visitor)');
    });

    await check('unlisted paste is noindex and its content is escaped', async () => {
        const r = await t.get('/p/dark-owl-55');
        assert.strictEqual(r.status, 200);
        has(r.text, '<meta name="robots" content="noindex,follow">');
        has(r.text, '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.ok(!r.text.includes('<script>alert(1)</script>'));
    });

    await check('screenshot paste uses the stored Media image as og:image and ImageObject JSON-LD', async () => {
        const r = await t.get('/p/fair-moon-23');
        has(r.text, '<meta property="og:image" content="https://openvibe.media/o/med_FAIRMOON">');
        has(r.text, '<meta name="twitter:card" content="summary_large_image">');
        has(r.text, '"@type":"ImageObject"');
        has(r.text, '<img src="https://openvibe.media/o/med_FAIRMOON"');
    });

    await check('private paste 404s for anonymous visitors and renders for its owner', async () => {
        const anon = await t.get('/p/grim-vale-61');
        assert.strictEqual(anon.status, 404);
        has(anon.text, 'Paste not found');
        const token = t.network.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex' });
        const owner = await t.get('/p/grim-vale-61', { cookies: [`ov_token=${token}`] });
        assert.strictEqual(owner.status, 200);
        has(owner.text, 'data-delete="grim-vale-61"', 'owner sees delete');
    });

    await check('raw serves the text from the store; screenshot redirects to the stored image; download is an attachment without a view', async () => {
        const raw = await t.get('/p/amber-fox-42/raw');
        assert.strictEqual(raw.status, 200);
        assert.ok(raw.text.startsWith('const greet'));
        const shot = await t.get('/p/fair-moon-23/screenshot');
        assert.strictEqual(shot.status, 302);
        assert.strictEqual(shot.headers.get('location'), 'https://openvibe.media/o/med_FAIRMOON');
        const before = (await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views;
        const dl = await t.get('/p/amber-fox-42/download');
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(dl.headers.get('content-disposition'), 'attachment; filename="amber-fox-42.js"');
        assert.ok(dl.text.startsWith('const greet'));
        assert.strictEqual((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views, before, 'download does not count a view');
    });

    await check('browse: search, views sort and language filter over the store, search pages are noindex', async () => {
        const all = await t.get('/pastes');
        assert.strictEqual(all.status, 200);
        has(all.text, '<link rel="canonical" href="https://openvibe.community/pastes">');
        has(all.text, 'href="/p/blue-lake-17"');
        const q = await t.get('/pastes?q=nginx');
        has(q.text, '<meta name="robots" content="noindex,follow">');
        has(q.text, 'href="/p/blue-lake-17"');
        assert.ok(!q.text.includes('href="/p/amber-fox-42"'));
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
        const token = t.network.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex' });
        const mine = await t.get('/my', { cookies: [`ov_token=${token}`] });
        assert.strictEqual(mine.status, 200);
        has(mine.text, '<meta name="robots" content="noindex,nofollow">');
        for (const slug of ['amber-fox-42', 'cold-ridge-88', 'dark-owl-55', 'grim-vale-61']) has(mine.text, `href="/p/${slug}"`);
        assert.ok(!mine.text.includes('blue-lake-17'));
    });

    await check('/new renders the form (private option only when signed in) and the no-JS post creates in the store', async () => {
        const anon = await t.get('/new');
        assert.strictEqual(anon.status, 200);
        has(anon.text, 'name="content"');
        assert.ok(!anon.text.includes('value="private"'));
        const token = t.network.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex' });
        const signed = await t.get('/new?fork=amber-fox-42', { cookies: [`ov_token=${token}`] });
        has(signed.text, 'value="private"');
        has(signed.text, 'Fork of Hello world in JavaScript');
        const body = new URLSearchParams({ title: 'via form', language: 'python', content: 'print(1)', visibility: 'public' }).toString();
        const post = await t.get('/new', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies: [`ov_token=${token}`] });
        assert.strictEqual(post.status, 303);
        const slug = post.headers.get('location').replace('/p/', '');
        assert.ok(/^[A-Za-z0-9_-]+$/.test(slug), `a generated slug, got ${slug}`);
        const row = await t.db.prepare('SELECT owner_subject, content FROM pastes WHERE slug = ?').get(slug);
        assert.deepStrictEqual(row, { owner_subject: alex.subject_id, content: 'print(1)' });
        const empty = await t.get('/new', { method: 'POST', body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.strictEqual(empty.status, 400);
        has(empty.text, 'content is empty');
        const anonPost = await t.get('/new', { method: 'POST', body: new URLSearchParams({ title: 'from anon', content: 'x' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
        assert.strictEqual(anonPost.status, 303, 'anonymous posts create in the store too');
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
