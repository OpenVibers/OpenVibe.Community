'use strict';
/**
 * The discovery data (server/discovery.js), the JSON-LD builders (server/render/jsonld.js) and the
 * page head (server/render/layout.js) as openvibe-shared/seo writes them, without booting the app.
 */
process.env.NODE_ENV = 'test';
process.env.BASE_URL = 'https://openvibe.community';
process.env.OV_LIVE_URL = 'https://openvibe.live';
const assert = require('assert');
const seo = require('openvibe-shared/seo');
const discovery = require('../server/discovery');
const catalog = require('../server/pastes/catalog');
const ld = require('../server/render/jsonld');
const { renderPage } = require('../server/render/layout');
const { check, done } = require('./helpers/app');

(async () => {
    await check('robots.txt keeps the disallow set for every crawler and names the sitemap', () => {
        const txt = seo.robotsTxt({ sitemaps: ['https://openvibe.community/sitemap.xml'], disallow: discovery.ROBOTS_DISALLOW });
        assert.deepStrictEqual(discovery.ROBOTS_DISALLOW, ['/api/', '/auth/', '/my', '/new', '/*?sso=']);
        assert.ok(txt.startsWith('User-agent: *\nAllow: /\nDisallow: /api/\n'));
        assert.strictEqual(txt.split('Disallow: /*?sso=').length - 1, 2, 'the generic and the search/AI group both disallow');
        assert.ok(txt.endsWith('Sitemap: https://openvibe.community/sitemap.xml\n'));
    });

    await check('llms.txt sections link the site, the feeds and llms-full.txt', () => {
        const txt = seo.llmsTxt({ name: 'OpenVibe.Community', summary: discovery.SUMMARY, details: discovery.CONTENT_LABELS, sections: discovery.llmsSections() });
        assert.ok(txt.includes('## Browse\n\n- [Pastes](https://openvibe.community/pastes): public pastes, newest first'));
        assert.ok(txt.includes('- [Full text for language models](https://openvibe.community/llms-full.txt)'));
        assert.ok(txt.includes('labelled as AI-generated'));
    });

    await check('page head: one canonical, og/twitter from headTags, ai-summary, article times, JSON-LD escaped', () => {
        const page = renderPage({ title: 'Hello', description: 'A paste.', canonicalPath: '/p/x', ogType: 'article', published: '2026-09-15T10:00:00.000Z', jsonLd: [{ '@type': 'Thing', name: '</script><b>' }] });
        const head = page.split('</head>')[0];
        assert.ok(head.includes('<title>Hello · OpenVibe.Community</title>'));
        assert.strictEqual((head.match(/<title>/g) || []).length, 1);
        assert.strictEqual((head.match(/<link rel="canonical" href="https:\/\/openvibe.community\/p\/x">/g) || []).length, 1);
        assert.ok(head.includes('<meta property="og:type" content="article">'));
        assert.ok(head.includes('<meta name="twitter:card" content="summary">'), 'no large card without a page image');
        assert.ok(head.includes('<meta name="ai-summary" content="A paste.">'));
        assert.ok(head.includes('<meta property="article:published_time" content="2026-09-15T10:00:00.000Z">'));
        assert.ok(head.includes('"name":"\\u003c/script>\\u003cb>"') && !head.includes('</script><b>'));
    });

    await check('a description over 160 characters loses whole sentences, never half a phrase', () => {
        const long = `${'A sentence that is long enough. '.repeat(4)}The people of OpenVibe made this. Free speech within the rules.`;
        const head = renderPage({ description: long }).split('</head>')[0];
        const [, desc] = head.match(/<meta name="description" content="([^"]*)">/);
        assert.ok(desc.length <= 160 && desc.endsWith('.') && !/Free/.test(desc), desc);
    });

    done();
})();
