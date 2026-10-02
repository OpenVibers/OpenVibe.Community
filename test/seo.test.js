'use strict';
/** robots.txt, sitemap.xml, feed.xml, and the static-asset cache policy. */
const assert = require('assert');
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
        for (const d of ['/api/', '/auth/', '/my', '/new']) assert.ok(r.text.includes(`Disallow: ${d}`));
        assert.ok(r.text.includes('Sitemap: https://openvibe.community/sitemap.xml'));
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
    });

    await check('feed.xml is a valid-looking RSS of the latest pastes', async () => {
        const r = await t.get('/feed.xml');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<rss version="2.0"'));
        assert.ok(r.text.includes('<link>https://openvibe.community/p/amber-fox-42</link>'));
        assert.ok(r.text.includes('<dc:creator'));
    });

    await check('assets: hashed ?v= is immutable, everything else revalidates; the page references the hashed URLs', async () => {
        const home = await t.get('/');
        const m = home.text.match(/\/css\/community\.css\?v=([0-9a-f]{10})/);
        assert.ok(m, 'hashed css url in page');
        const hashed = await t.get(`/css/community.css?v=${m[1]}`);
        assert.strictEqual(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
        const plain = await t.get('/css/community.css');
        assert.strictEqual(plain.headers.get('cache-control'), 'public, max-age=300, stale-while-revalidate=86400');
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
