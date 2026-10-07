'use strict';
/** robots.txt, llms.txt, llms-full.txt, sitemap.xml, feed.xml (all written by openvibe-shared/seo), the
 *  page head, the JSON-LD builders (server/render/jsonld.js) and the cache policy (openvibe-shared/cache-policy). */
const assert = require('assert');
const cache = require('openvibe-shared/cache-policy');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const alex = t.network.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = t.network.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const ins = t.db.prepare(`INSERT INTO pastes (slug, owner_subject, type, title, content, language, visibility, screenshot_url, views, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    await ins.run('amber-fox-42', alex.subject_id, 'paste', 'Hello world in JavaScript', 'const x = 1;\n', 'javascript', 'public', null, 120, '2026-09-15 10:00:00', '2026-09-15 10:00:00');
    await ins.run('fair-moon-23', sam.subject_id, 'screenshot', 'Desktop shot', 'my desktop', 'text', 'public', 'https://openvibe.media/o/med_FAIRMOON', 40, '2026-09-11 08:00:00', '2026-09-11 08:00:00');
    await ins.run('dark-owl-55', alex.subject_id, 'paste', 'secret notes', 'unlisted', 'text', 'unlisted', null, 2, '2026-09-12 08:00:00', '2026-09-12 08:00:00');
    await ins.run('grim-vale-61', alex.subject_id, 'paste', 'private thing', 'private', 'text', 'private', null, 0, '2026-09-10 08:00:00', '2026-09-10 08:00:00');

    await check('robots.txt allows crawling, blocks the private routes, points at the sitemap', async () => {
        const r = await t.get('/robots.txt');
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers.get('content-type').startsWith('text/plain'));
        assert.ok(r.text.includes('User-agent: *\nAllow: /'));
        for (const d of ['/api/', '/auth/', '/my', '/new', '/*?sso=']) assert.ok(r.text.includes(`Disallow: ${d}\n`), d);
        assert.ok(r.text.includes('Sitemap: https://openvibe.community/sitemap.xml'));
        assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 3600 }));
    });

    await check('llms.txt maps the site; llms-full.txt carries the public pastes in full', async () => {
        const r = await t.get('/llms.txt');
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers.get('content-type').startsWith('text/plain'));
        assert.ok(r.text.startsWith('# OpenVibe.Community\n'));
        assert.ok(r.text.includes('- [Latest pastes (RSS)](https://openvibe.community/feed.xml)'));
        assert.ok(r.text.includes('- [Full text for language models](https://openvibe.community/llms-full.txt)'));
        const full = await t.get('/llms-full.txt');
        assert.strictEqual(full.status, 200);
        assert.ok(full.headers.get('content-type').startsWith('text/plain'));
        assert.strictEqual(full.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 3600 }));
        assert.ok(full.text.includes('### Hello world in JavaScript\n\nURL: https://openvibe.community/p/amber-fox-42\n\nconst x = 1;'));
        assert.ok(!full.text.includes('dark-owl-55') && !full.text.includes('grim-vale-61') && !full.text.includes('secret notes'));

        // The catalog keeps a short preview for a few seconds. Discovery must read the
        // current full row and omit it if its visibility changes after the listing.
        const long = 'a'.repeat(4200) + ' END_OF_PASTE';
        const before = (await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views;
        try {
            await t.db.prepare('UPDATE pastes SET content = ? WHERE slug = ?').run(long, 'amber-fox-42');
            const expanded = await t.get('/llms-full.txt');
            assert.ok(expanded.text.includes(long), 'the full paste survives the preview and 4,000-character limits');
            assert.strictEqual((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views, before);

            await t.db.prepare("UPDATE pastes SET visibility = 'private' WHERE slug = ?").run('amber-fox-42');
            assert.ok(!(await t.get('/llms-full.txt')).text.includes('amber-fox-42'), 'cached public preview cannot expose a private paste');

            await t.db.prepare("UPDATE pastes SET visibility = 'public', burn_after_read = 1 WHERE slug = ?").run('amber-fox-42');
            assert.ok(!(await t.get('/llms-full.txt')).text.includes('amber-fox-42'), 'a newly burning paste is omitted without a view');
            assert.strictEqual((await t.db.prepare('SELECT views FROM pastes WHERE slug = ?').get('amber-fox-42')).views, before);

            await t.db.prepare('UPDATE pastes SET burn_after_read = 0, is_nsfw = 1 WHERE slug = ?').run('amber-fox-42');
            assert.ok(!(await t.get('/llms-full.txt')).text.includes('amber-fox-42'), 'a newly NSFW paste is omitted');
        } finally {
            await t.db.prepare('UPDATE pastes SET content = ?, visibility = ?, burn_after_read = 0, is_nsfw = 0 WHERE slug = ?')
                .run('const x = 1;\n', 'public', 'amber-fox-42');
        }
    });

    await check('sitemap.xml lists home, /pastes and every recent public paste — never unlisted/private', async () => {
        const r = await t.get('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.ok(r.headers.get('content-type').includes('xml'));
        assert.ok(r.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
        assert.ok(r.text.includes('<loc>https://openvibe.community/</loc>'));
        assert.ok(r.text.includes('<loc>https://openvibe.community/pastes</loc>'));
        assert.ok(r.text.includes('<loc>https://openvibe.community/p/amber-fox-42</loc>'));
        assert.ok(r.text.includes('<lastmod>2026-09-15</lastmod>'));
        assert.ok(r.text.includes('/p/fair-moon-23'));
        assert.ok(!r.text.includes('dark-owl-55') && !r.text.includes('grim-vale-61'));
        assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 3600 }));
    });

    await check('feed.xml is a valid-looking RSS of the latest pastes', async () => {
        const r = await t.get('/feed.xml');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<rss version="2.0"'));
        assert.ok(r.text.includes('<link>https://openvibe.community/p/amber-fox-42</link>'));
        assert.ok(r.text.includes('<atom:link href="https://openvibe.community/feed.xml" rel="self" type="application/rss+xml"/>'));
        assert.ok(r.text.includes('<author>Alex</author>'));
        assert.ok(r.text.includes('<pubDate>Tue, 15 Sep 2026 10:00:00 GMT</pubDate>'));
        assert.ok(!r.text.includes('secret notes'));
        assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders({ maxAge: 900 }));
    });

    await check('a page head has the canonical, Open Graph, Twitter and ai-summary tags from openvibe-shared/seo', async () => {
        const r = await t.get('/p/amber-fox-42');
        assert.strictEqual(r.status, 200);
        const head = r.text.split('</head>')[0];
        assert.ok(head.includes('<link rel="canonical" href="https://openvibe.community/p/amber-fox-42">'));
        assert.ok(head.includes('<meta property="og:url" content="https://openvibe.community/p/amber-fox-42">'));
        assert.ok(head.includes('<meta property="og:title" content="Hello world in JavaScript · OpenVibe.Community">'));
        assert.ok(head.includes('<meta property="og:site_name" content="OpenVibe.Community">'));
        assert.match(head, /<meta property="og:description" content="[^"]+">/);
        assert.match(head, /<meta name="twitter:title" content="Hello world in JavaScript · OpenVibe.Community">/);
        assert.match(head, /<meta name="ai-summary" content="[^"]+">/);
        assert.match(head, /<meta property="article:published_time" content="2026-09-15T10:00:00.000Z">/);
        assert.ok(head.includes('"@type":"BreadcrumbList"') && head.includes('"@type":"WebPage"'));
        assert.strictEqual((head.match(/<link rel="canonical"/g) || []).length, 1, 'one canonical');
    });

    await check('HTML pages carry the private page policy; raw and download never reach a shared cache', async () => {
        for (const path of ['/', '/pastes', '/p/amber-fox-42', '/updates', '/nope-not-a-page']) {
            const r = await t.get(path);
            assert.ok(r.headers.get('content-type').startsWith('text/html'), path);
            assert.strictEqual(r.headers.get('cache-control'), cache.htmlHeaders({ private: true }), path);
        }
        assert.strictEqual((await t.get('/p/amber-fox-42/raw')).headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await t.get('/p/amber-fox-42/download')).headers.get('cache-control'), 'private, no-store');
    });

    await check('JSON-LD builders (server/render/jsonld.js): absolute breadcrumbs, a paste Article, AI never a person', async () => {
        const ld = require('../server/render/jsonld');   // after boot: the test config is loaded
        const crumbs = ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }]);
        assert.deepStrictEqual(crumbs.itemListElement.map((i) => i.item), ['https://openvibe.community/', 'https://openvibe.community/pastes']);
        const paste = ld.pasteLd({ slug: 'amber-fox-42', type: 'paste', title: 'Hi', language: 'javascript', created_at: '2026-09-15 10:00:00', views: 3 }, { description: 'd', image: 'i' });
        assert.strictEqual(paste['@type'], 'Article');
        assert.strictEqual(paste.datePublished, '2026-09-15T10:00:00.000Z');
        assert.strictEqual(paste.hasPart.programmingLanguage, 'javascript');
        assert.strictEqual(ld.discussionAuthorLd, undefined, 'forum JSON-LD moved to OpenVibe.Space');
        assert.strictEqual(ld.websiteLd().potentialAction.target.urlTemplate, 'https://openvibe.community/pastes?q={search_term_string}');
        assert.strictEqual(ld.clean('a  b  c', 4), 'a b…');
    });

    await check('assets: hashed ?v= is immutable, everything else revalidates; the page references the hashed URLs', async () => {
        const home = await t.get('/');
        const m = home.text.match(/\/css\/community\.css\?v=([0-9a-f]{10})/);
        assert.ok(m, 'hashed css url in page');
        const hashed = await t.get(`/css/community.css?v=${m[1]}`);
        assert.strictEqual(hashed.headers.get('cache-control'), cache.IMMUTABLE);
        const plain = await t.get('/css/community.css');
        assert.strictEqual(plain.headers.get('cache-control'), cache.assetHeaders('css/community.css', { hashed: false }));
        const fav = await t.get('/favicon.svg');
        assert.strictEqual(fav.status, 200);
        const og = await t.get('/og-default.png');
        assert.strictEqual(og.status, 200);
    });

    await check('security headers are present on pages', async () => {
        const r = await t.get('/');
        const csp = r.headers.get('content-security-policy');
        assert.ok(csp.includes("script-src 'self' 'unsafe-inline' https://openvibe.network"));
        // Cloudflare Web Analytics (injected at the edge, disclosed in the privacy text) may load and report.
        assert.match(csp, /script-src [^;]*https:\/\/static\.cloudflareinsights\.com/);
        assert.match(csp, /connect-src [^;]*https:\/\/cloudflareinsights\.com/);
        assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(r.headers.get('x-powered-by'), null);
    });

    await t.close();
    done();
})();
