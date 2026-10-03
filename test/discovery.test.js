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
const ld = require('../server/render/jsonld');
const { renderPage } = require('../server/render/layout');
const { check, done } = require('./helpers/app');

(async () => {
    await check('robots.txt keeps the disallow set for every crawler and names the sitemap', () => {
        const txt = seo.robotsTxt({ sitemaps: ['https://openvibe.community/sitemap.xml'], disallow: discovery.ROBOTS_DISALLOW });
        assert.deepStrictEqual(discovery.ROBOTS_DISALLOW, ['/api/', '/auth/', '/my', '/new', '/s/*/new', '/*?sso=']);
        assert.ok(txt.startsWith('User-agent: *\nAllow: /\nDisallow: /api/\n'));
        assert.strictEqual(txt.split('Disallow: /*?sso=').length - 1, 2, 'the generic and the search/AI group both disallow');
        assert.ok(txt.endsWith('Sitemap: https://openvibe.community/sitemap.xml\n'));
    });

    await check('llms.txt sections link the site, the feeds and llms-full.txt', () => {
        const txt = seo.llmsTxt({ name: 'OpenVibe.Community', summary: discovery.SUMMARY, details: discovery.CONTENT_LABELS, sections: discovery.llmsSections() });
        assert.ok(txt.includes('## Browse\n\n- [Pastes](https://openvibe.community/pastes): public pastes, newest first'));
        assert.ok(txt.includes('- [Latest threads (RSS)](https://openvibe.community/s/feed.xml)'));
        assert.ok(txt.includes('- [Full text for language models](https://openvibe.community/llms-full.txt)'));
        assert.ok(txt.includes('labelled as AI-generated'));
    });

    await check('thread feed items use the 2.5.0 feedXml shape and keep the thread link as guid', () => {
        const items = discovery.threadFeedItems([{ title: 'Hi <b>', space_slug: 'general', slug: 'hi-1', opening: 'Some **text**', created_at: '2026-09-15 10:00:00', last_activity_at: '2026-09-16 10:00:00' }]);
        assert.deepStrictEqual(Object.keys(items[0]), ['title', 'link', 'guid', 'description', 'content', 'author', 'published', 'updated']);
        assert.strictEqual(items[0].link, 'https://openvibe.community/s/general/t/hi-1');
        assert.strictEqual(items[0].published, '2026-09-15T10:00:00.000Z');
        assert.strictEqual(items[0].updated, '2026-09-16T10:00:00.000Z');
        const xml = seo.feedXml({ title: 't', link: 'https://openvibe.community/s', description: 'd', selfUrl: 'https://openvibe.community/s/feed.xml', items }, { format: 'rss' });
        assert.ok(xml.includes('<atom:link href="https://openvibe.community/s/feed.xml" rel="self" type="application/rss+xml"/>'));
        assert.ok(xml.includes('<title>Hi &lt;b&gt;</title>'));
        assert.ok(xml.includes('<pubDate>Tue, 15 Sep 2026 10:00:00 GMT</pubDate>'));
    });

    await check('JSON-LD: thread posting with comments, people linked to Live, AI never a person', () => {
        const thread = { slug: 'hi-1', title: 'Hi', created_at: '2026-09-15 10:00:00', reply_count: 1, score: 2, author: { username: 'alex', display_name: 'Alex' } };
        const posts = [{ id: 1, is_opening: true, body_markdown: 'open' }, { id: 2, body_markdown: 'reply', author: { is_ai: true, display_name: 'OpenVibe AI' }, created_at: '2026-09-15 11:00:00' }];
        const out = ld.threadLd({ space: { slug: 'general', name: 'General' }, thread, posts, opening: posts[0], description: 'd' });
        assert.strictEqual(out['@type'], 'DiscussionForumPosting');
        assert.deepStrictEqual(out.author, { '@type': 'Person', name: 'Alex', url: 'https://openvibe.live/@alex' });
        assert.deepStrictEqual(out.comment[0].author, { '@type': 'Organization', name: 'OpenVibe AI' });
        assert.strictEqual(out.comment[0].url, 'https://openvibe.community/s/general/t/hi-1#post-2');
        assert.strictEqual(ld.isoDate('nope'), null);
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
