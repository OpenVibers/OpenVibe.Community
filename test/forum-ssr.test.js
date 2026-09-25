'use strict';
/**
 * Forum pages without JavaScript: /s, /s/:space (sort + pagination links), /s/:space/t/:slug
 * (posts, reply/vote/moderation forms), /s/:space/new — plain form posts, SEO (canonical, OG,
 * JSON-LD DiscussionForumPosting, robots for members/staff spaces), sitemap, feeds, robots.txt.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const forumStore = require('../server/forum/store');

const ld = (html) => (html.match(/<script type="application\/ld\+json">(.*?)<\/script>/g) || []).map((s) => JSON.parse(s.replace(/<script[^>]*>|<\/script>/g, '')));
const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);
const form = (obj) => ({ method: 'POST', body: new URLSearchParams(obj).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    // These pages are the feed style (render/forum.js): General is a forum board by default, so it becomes a feed with votes here.
    t.db.prepare("UPDATE spaces SET style = 'feed', votes = 1 WHERE slug = 'general'").run();
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'admin' });
    const as = (jwt, opts = {}) => ({ ...opts, cookies: [`ov_token=${jwt}`] });

    await check('/s lists the public spaces with SEO head, breadcrumbs and the threads feed', async () => {
        const r = await t.get('/s');
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>Spaces · OpenVibe.Community</title>');
        has(r.text, '<link rel="canonical" href="https://openvibe.community/s">');
        has(r.text, '<meta name="robots" content="index,follow">');
        has(r.text, 'href="/s/feed.xml"');
        for (const s of ['general', 'feedback', 'showcase']) has(r.text, `href="/s/${s}"`);
        assert.ok(ld(r.text).some((o) => o['@type'] === 'BreadcrumbList'));
        const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.links.find((l) => l.href === '/s').active, true);
    });

    await check('no-JS new thread: anonymous → sign in; signed in → 303 to the thread; errors re-render escaped', async () => {
        const page = await t.get('/s/general/new');
        assert.strictEqual(page.status, 200);
        has(page.text, '/auth/login?next=%2Fs%2Fgeneral%2Fnew');
        has(page.text, '<meta name="robots" content="noindex,follow">');
        const anon = await t.get('/s/general/new', form({ title: 'Anon thread', body: 'x' }));
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /^\/auth\/login\?next=%2Fs%2Fgeneral%2Fnew$/);
        const bad = await t.get('/s/general/new', as(alexJwt, form({ title: 'x', body: '<img src=x onerror=alert(1)>' })));
        assert.strictEqual(bad.status, 400);
        has(bad.text, 'Titles are 3 to 200 characters');
        has(bad.text, '&lt;img src=x onerror=alert(1)&gt;</textarea>');
        const ok = await t.get('/s/general/new', as(alexJwt, form({ title: 'How do I <b>embed</b> comments?', body: 'Asking for **Live**.\n\n```js\nconst x = "<y>";\n```\n\n<script>alert(1)</script>' })));
        assert.strictEqual(ok.status, 303, ok.text);
        assert.strictEqual(ok.headers.get('location'), '/s/general/t/how-do-i-b-embed-b-comments');
        const foreign = await t.get('/s/general/new', as(alexJwt, { ...form({ title: 'Cross site', body: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } }));
        assert.strictEqual(foreign.status, 403, 'a form sent from another site is refused');
    });

    const url = '/s/general/t/how-do-i-b-embed-b-comments';

    await check('thread page: escaped title, safe Markdown, canonical, OG article, JSON-LD DiscussionForumPosting', async () => {
        const r = await t.get(url);
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>How do I &lt;b&gt;embed&lt;/b&gt; comments? · OpenVibe.Community</title>');
        has(r.text, `<link rel="canonical" href="https://openvibe.community${url}">`);
        has(r.text, '<meta property="og:type" content="article">');
        has(r.text, '<meta property="article:published_time"');
        has(r.text, '<strong>Live</strong>');
        has(r.text, '<code class="hljs language-javascript"><span class="hljs-keyword">const</span>');
        has(r.text, '&lt;script&gt;alert(1)&lt;/script&gt;');
        assert.ok(!r.text.includes('<script>alert(1)</script>'));
        const post = ld(r.text).find((o) => o['@type'] === 'DiscussionForumPosting');
        assert.ok(post, 'DiscussionForumPosting JSON-LD');
        assert.strictEqual(post.headline, 'How do I <b>embed</b> comments?');
        assert.strictEqual(post.url, `https://openvibe.community${url}`);
        assert.deepStrictEqual(post.author, { '@type': 'Person', name: 'Alex', url: 'https://openvibe.live/@alex' });
        assert.ok(post.datePublished && post.text.startsWith('Asking for Live.'));
        assert.strictEqual(post.commentCount, 0);
        assert.ok(!r.text.match(/<script type="application\/ld\+json">[^<]*<\/script>/g).some((s) => /<\/(b|script)>/i.test(s.slice(35, -9))), 'no raw closing tags inside JSON-LD');
        assert.ok(ld(r.text).some((o) => o['@type'] === 'BreadcrumbList' && o.itemListElement.length === 4));
        has(r.text, `/auth/login?next=${encodeURIComponent(url)}`, 'anonymous readers get a sign-in link instead of the form');
        assert.ok(!r.text.includes(`action="${url}/reply"`));
    });

    await check('no-JS reply and vote: 303 back to the post; score and replies render; JSON-LD comments', async () => {
        const reply = await t.get(`${url}/reply`, as(samJwt, form({ body: 'Use **/api/v1/comments**.' })));
        assert.strictEqual(reply.status, 303, reply.text);
        assert.match(reply.headers.get('location'), new RegExp(`^${url}#post-\\d+$`));
        const empty = await t.get(`${url}/reply`, as(samJwt, form({ body: '   ' })));
        assert.strictEqual(empty.status, 400);
        has(empty.text, 'Write something first');
        const vote = await t.get(`${url}/vote`, as(samJwt, form({ value: '1' })));
        assert.strictEqual(vote.status, 303);
        assert.strictEqual(vote.headers.get('location'), url);
        const r = await t.get(url, as(samJwt));
        has(r.text, `action="${url}/reply"`);
        has(r.text, `action="${url}/vote"`);
        has(r.text, 'class="vote-btn active" type="submit" name="value" value="0" aria-pressed="true"', 'pressing your vote again removes it');
        has(r.text, '<span class="vote-score" title="Score">1</span>');
        has(r.text, 'Use <strong>/api/v1/comments</strong>.');
        const post = ld(r.text).find((o) => o['@type'] === 'DiscussionForumPosting');
        assert.strictEqual(post.commentCount, 1);
        assert.strictEqual(post.comment[0].author.name, 'Sam');
        assert.ok(post.comment[0].url.includes('#post-'));
        const anonVote = await t.get(`${url}/vote`, form({ value: '1' }));
        assert.strictEqual(anonVote.status, 303);
        assert.match(anonVote.headers.get('location'), /^\/auth\/login/);
    });

    await check('moderation forms: people 403, staff pin and lock; the author deletes their thread', async () => {
        assert.strictEqual((await t.get(`${url}/state`, as(samJwt, form({ pinned: '1' })))).status, 403);
        assert.strictEqual((await t.get(`${url}/state`, as(adminJwt, form({ pinned: '1' })))).status, 303);
        assert.strictEqual((await t.get(`${url}/state`, as(adminJwt, form({ locked: '1' })))).status, 303);
        const r = await t.get(url, as(samJwt));
        has(r.text, 'This thread is locked.');
        assert.ok(!r.text.includes(`action="${url}/reply"`));
        const list = await t.get('/s/general');
        has(list.text, '<i class="fa-solid fa-thumbtack" title="Pinned" aria-label="Pinned"></i>');
        const admin = await t.get(url, as(adminJwt));
        has(admin.text, 'Unpin');
        has(admin.text, 'Unlock');
        const mine = await t.get('/s/general/new', as(samJwt, form({ title: 'Short lived', body: 'x' })));
        const mineUrl = mine.headers.get('location');
        assert.strictEqual((await t.get(`${mineUrl}/delete`, as(alexJwt, form({})))).status, 403);
        const del = await t.get(`${mineUrl}/delete`, as(samJwt, form({})));
        assert.strictEqual(del.status, 303);
        assert.strictEqual(del.headers.get('location'), '/s/general');
        assert.strictEqual((await t.get(mineUrl)).status, 404);
    });

    await check('space page: hot/new/top tabs as links, server pagination with rel=prev/next and canonical', async () => {
        const space = forumStore.getSpace(t.db, 'showcase');
        for (let i = 1; i <= 27; i++) forumStore.createThread(t.db, { space_id: space.id, title: `Showcase item ${i}`, author_subject: alex.subject_id, body_markdown: `item ${i}` });
        const p1 = await t.get('/s/showcase?sort=new');
        assert.strictEqual(p1.status, 200);
        has(p1.text, '<link rel="canonical" href="https://openvibe.community/s/showcase?sort=new">');
        has(p1.text, 'href="/s/showcase"');
        has(p1.text, 'href="/s/showcase?sort=top"');
        has(p1.text, 'rel="next" href="/s/showcase?sort=new&amp;page=2"');
        has(p1.text, 'Page 1 of 2');
        assert.strictEqual((p1.text.match(/class="thread-row"/g) || []).length, 25);
        const p2 = await t.get('/s/showcase?sort=new&page=2');
        has(p2.text, 'rel="prev" href="/s/showcase?sort=new"');
        has(p2.text, '<link rel="canonical" href="https://openvibe.community/s/showcase?sort=new&amp;page=2">');
        has(p2.text, 'Showcase item 1<');
        assert.strictEqual((await t.get('/s/showcase?page=9')).status, 404);
        assert.strictEqual((await t.get('/s/nowhere')).status, 404);
    });

    await check('members and staff spaces: sign-in redirect, noindex for members, 404 for non-staff; never in feeds or sitemap', async () => {
        t.db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members'), ('mods', 'Mods', 'staff')").run();
        const ins = forumStore.getSpace(t.db, 'insiders');
        forumStore.createThread(t.db, { space_id: ins.id, title: 'Members only chat', author_subject: alex.subject_id, body_markdown: 'psst' });
        const anon = await t.get('/s/insiders');
        assert.strictEqual(anon.status, 303);
        assert.strictEqual(anon.headers.get('location'), '/auth/login?next=%2Fs%2Finsiders');
        const member = await t.get('/s/insiders', as(samJwt));
        assert.strictEqual(member.status, 200);
        has(member.text, '<meta name="robots" content="noindex,nofollow">');
        const th = await t.get('/s/insiders/t/members-only-chat', as(samJwt));
        has(th.text, '<meta name="robots" content="noindex,nofollow">');
        assert.strictEqual((await t.get('/s/mods', as(samJwt))).status, 404);
        assert.strictEqual((await t.get('/s/mods', as(adminJwt))).status, 200);
        const feed = await t.get('/s/feed.xml');
        assert.ok(!feed.text.includes('Members only chat'));
        assert.strictEqual((await t.get('/s/insiders/feed.xml')).status, 404);
        require('../server/seo').resetCaches();
        const map = await t.get('/sitemap.xml');
        assert.ok(!map.text.includes('members-only-chat'));
    });

    await check('AI threads are labelled as AI on the page and in JSON-LD (never a person)', async () => {
        const space = forumStore.getSpace(t.db, 'feedback');
        forumStore.createThread(t.db, { space_id: space.id, title: 'Weekly summary', origin: 'ai', body_markdown: 'What people asked for.' });
        const r = await t.get('/s/feedback/t/weekly-summary');
        has(r.text, 'OpenVibe AI');
        has(r.text, '<span class="badge badge-ai"');
        assert.deepStrictEqual(ld(r.text).find((o) => o['@type'] === 'DiscussionForumPosting').author, { '@type': 'Organization', name: 'OpenVibe AI' });
    });

    await check('sitemap, feeds and robots.txt include the forum', async () => {
        require('../server/seo').resetCaches();
        const map = await t.get('/sitemap.xml');
        for (const loc of ['/s', '/s/general', '/pulse', url]) has(map.text, `<loc>https://openvibe.community${loc}</loc>`);
        const feed = await t.get('/s/feed.xml');
        assert.strictEqual(feed.status, 200);
        has(feed.text, '<rss version="2.0"');
        has(feed.text, `<link>https://openvibe.community${url}</link>`);
        has(feed.text, '<title>How do I &lt;b&gt;embed&lt;/b&gt; comments?</title>');
        const spaceFeed = await t.get('/s/showcase/feed.xml');
        has(spaceFeed.text, 'Showcase item 27');
        assert.ok(!spaceFeed.text.includes('embed'));
        const robots = await t.get('/robots.txt');
        has(robots.text, 'Disallow: /s/*/new');
    });

    await t.close();

    // The forum lives in Community's database in every mode, including PASTES_AUTHORITY=live.
    const live = await boot();
    await check('forum pages work with PASTES_AUTHORITY=live too', async () => {
        const r = await live.get('/s/general');
        assert.strictEqual(r.status, 200);
        has(r.text, '<h1>General</h1>');
    });
    await live.close();
    done();
})();
