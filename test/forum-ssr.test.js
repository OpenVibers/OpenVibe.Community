'use strict';
/**
 * Forum pages without JavaScript: /forum, /forum/:space (sort + pagination links), /forum/:space/:slug
 * (posts, reply/vote/moderation forms), /forum/:space/new — plain form posts, SEO (canonical, OG,
 * JSON-LD DiscussionForumPosting, robots for members/staff spaces), sitemap, feeds, robots.txt.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const forumStore = require('../server/forum/store');
const { draftPrefill } = require('../server/forum/prefill');

const ld = (html) => (html.match(/<script type="application\/ld\+json">(.*?)<\/script>/g) || []).map((s) => JSON.parse(s.replace(/<script[^>]*>|<\/script>/g, '')));
const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const form = (obj) => ({ method: 'POST', body: new URLSearchParams(obj).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    // These pages are the feed style (render/forum.js): General is a forum board by default, so it becomes a feed with votes here.
    await t.db.prepare("UPDATE spaces SET style = 'feed', votes = 1 WHERE slug = 'general'").run();
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'admin' });
    const as = (jwt, opts = {}) => ({ ...opts, cookies: [`ov_token=${jwt}`] });

    await check('/forum lists the public spaces with SEO head, breadcrumbs and the threads feed', async () => {
        const r = await t.get('/forum');
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>Forum · OpenVibe.Community</title>');
        has(r.text, '<link rel="canonical" href="https://openvibe.community/forum">');
        has(r.text, '<meta name="robots" content="index,follow">');
        has(r.text, 'href="/forum/feed.xml"');
        for (const s of ['general', 'feedback', 'showcase']) has(r.text, `href="/forum/${s}"`);
        assert.ok(ld(r.text).some((o) => o['@type'] === 'BreadcrumbList'));
        const cfg = JSON.parse(r.text.match(/window\.__OV_PAGE = (.*);\n/)[1]);
        assert.strictEqual(cfg.navbar.links.find((l) => l.href === '/forum').active, true);
    });

    await check('no-JS new thread: anonymous → sign in; signed in → 303 to the thread; errors re-render escaped', async () => {
        const page = await t.get('/forum/general/new');
        assert.strictEqual(page.status, 200);
        has(page.text, '/auth/login?next=%2Fforum%2Fgeneral%2Fnew');
        has(page.text, '<meta name="robots" content="noindex,follow">');
        const anon = await t.get('/forum/general/new', form({ title: 'Anon thread', body: 'x' }));
        assert.strictEqual(anon.status, 303);
        assert.match(anon.headers.get('location'), /^\/auth\/login\?next=%2Fforum%2Fgeneral%2Fnew$/);
        const bad = await t.get('/forum/general/new', as(alexJwt, form({ title: 'x', body: '<img src=x onerror=alert(1)>' })));
        assert.strictEqual(bad.status, 400);
        has(bad.text, 'Titles are 3 to 200 characters');
        has(bad.text, '&lt;img src=x onerror=alert(1)&gt;</textarea>');
        const ok = await t.get('/forum/general/new', as(alexJwt, form({ title: 'How do I <b>embed</b> comments?', body: 'Asking for **Live**.\n\n```js\nconst x = "<y>";\n```\n\n<script>alert(1)</script>' })));
        assert.strictEqual(ok.status, 303, ok.text);
        assert.strictEqual(ok.headers.get('location'), '/forum/general/how-do-i-b-embed-b-comments');
        const foreign = await t.get('/forum/general/new', as(alexJwt, { ...form({ title: 'Cross site', body: 'x' }), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' } }));
        assert.strictEqual(foreign.status, 403, 'a form sent from another site is refused');
    });

    await check('share drafts travel through the forum picker into the prefilled form, escaped and never in the head', async () => {
        const title = '<script>alert("title")</script> Meme remix draft-9f3a';
        const body = '<script>alert("body")</script>\nMade this with OpenVibe.Meme: https://openvibe.meme/c/mcp_01ARZ3NDEKTSV4RRFFQ69G5FAV draft-9f3a';
        const query = new URLSearchParams({ title, body }).toString();
        const target = `/forum/general/new?${query}`;
        const discuss = await t.get(`/forum/discuss?${query}`);
        assert.strictEqual(discuss.status, 200);
        assert.ok(discuss.text.includes(`href="${target}"`), 'the picker carries the draft into every space');
        assert.ok(discuss.text.includes(`/auth/login?next=${encodeURIComponent(`/forum/discuss?${query}`)}`), 'signing in from the picker keeps the draft query');
        assert.ok(!discuss.text.slice(0, discuss.text.indexOf('</head>')).includes('draft-9f3a'), 'the draft never reaches the picker head');
        has(discuss.text, '<link rel="canonical" href="https://openvibe.community/forum/discuss">');

        const page = await t.get(target, as(alexJwt));
        assert.strictEqual(page.status, 200);
        has(page.text, 'data-ov-guide="community.thread"', 'the signed-in thread form has the guide target');
        has(page.text, `value="${esc(title)}"`, 'the title is escaped in the form value');
        has(page.text, `>${esc(body)}</textarea>`, 'the body is escaped in the textarea');
        assert.ok(!page.text.includes('<script>alert("title")</script>') && !page.text.includes('<script>alert("body")</script>'), 'no raw draft HTML');
        assert.ok(!page.text.slice(0, page.text.indexOf('</head>')).includes('draft-9f3a'), 'the draft never reaches the title, meta tags or canonical');
        has(page.text, '<title>New thread · General · OpenVibe.Community</title>');
        has(page.text, '<link rel="canonical" href="https://openvibe.community/forum/general/new">');
        assert.strictEqual(page.headers.get('cache-control'), 'private, no-store', 'a prefilled form is never cached');
        assert.match(page.headers.get('x-robots-tag') || '', /noindex/, 'a prefilled form is never indexed');

        const picker = await t.get(`/forum/discuss?paste=snip1&${query}`);
        has(picker.text, `/forum/general/new?paste=snip1`, 'a paste and the draft travel together');
        const withPaste = await t.get(`/forum/general/new?paste=snip1&${query}`, as(alexJwt));
        assert.strictEqual(withPaste.status, 200);
        has(withPaste.text, 'name="pastes"', 'the paste stays attached to the draft');
        has(withPaste.text, 'value="snip1"');
        has(withPaste.text, `value="${esc(title)}"`);
        has(withPaste.text, `>${esc(body)}</textarea>`);
    });

    await check('a share link posts nothing; signed out it signs in and returns to the same prefilled form', async () => {
        const title = 'Draft marker 9f3a', body = 'Body marker 9f3a';
        const query = new URLSearchParams({ title, body }).toString();
        const target = `/forum/general/new?${query}`;
        const space = await forumStore.getSpace(t.db, 'general');
        const count = async () => Number((await t.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE space_id = ?').get(space.id)).n);
        const before = await count();

        const anon = await t.get(target);
        assert.strictEqual(anon.status, 303, 'signed out: sent to sign in before the form');
        const location = anon.headers.get('location');
        assert.ok(location.startsWith('/auth/login?next='), location);
        const next = decodeURIComponent(location.slice('/auth/login?next='.length));
        assert.strictEqual(next, target, 'sign-in returns to the same prefilled form');
        assert.ok(next.startsWith('/forum/general/new?'), 'next stays a same-site path');
        const anonPaste = await t.get('/forum/general/new?paste=snip1');
        assert.strictEqual(anonPaste.status, 303, 'a paste prefill signs in too');
        assert.ok(decodeURIComponent(anonPaste.headers.get('location').slice('/auth/login?next='.length)).includes('paste=snip1'));

        const page = await t.get(target, as(alexJwt));
        assert.strictEqual(page.status, 200);
        has(page.text, 'method="post" action="/forum/general/new"', 'the form is still reviewed and posted by the person');
        assert.strictEqual(await count(), before, 'opening a share link creates no thread');
        assert.ok(!(await t.get('/forum/general')).text.includes(title), 'the draft is not posted into the space');
    });

    await check('draft limits: title 200, body 40,000, and a long body is carried past the old 6,000 cut', async () => {
        const longTitle = 't'.repeat(250);
        const longBody = 'b'.repeat(10_000);
        const query = new URLSearchParams({ title: longTitle, body: longBody }).toString();
        const page = await t.get(`/forum/general/new?${query}`, as(alexJwt));
        assert.strictEqual(page.status, 200);
        const title = page.text.match(/name="title"[^>]*value="([^"]*)"/)[1];
        assert.strictEqual(title.length, 200, 'the title stops at 200 characters');
        const body = page.text.match(/<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/)[1];
        assert.strictEqual(body, longBody, 'a 10,000-character body is carried whole');
        const over = draftPrefill({ title: 'x'.repeat(250), body: 'y'.repeat(40_001) });
        assert.strictEqual(over.title.length, 200, 'the cap is 200 characters of title');
        assert.strictEqual(over.body.length, 40_000, 'the cap is 40,000 characters of body');
        assert.deepStrictEqual(draftPrefill({}), { title: '', body: '' });
    });

    const url = '/forum/general/how-do-i-b-embed-b-comments';

    await check('thread page: escaped title, safe Markdown, canonical, OG article, JSON-LD DiscussionForumPosting', async () => {
        const r = await t.get(url);
        assert.strictEqual(r.status, 200);
        has(r.text, '<title>How do I &lt;b&gt;embed&lt;/b&gt; comments? · OpenVibe.Community</title>');
        has(r.text, `<link rel="canonical" href="https://openvibe.community${url}">`);
        // The Ask your agent chip (openvibe-shared 4.135.0): in the thread's action row, its title escaped, its address.
        const asks = r.text.match(/<button[^>]*data-ov-ask[^>]*>/g) || [];
        assert.strictEqual(asks.length, 1, 'one Ask your agent chip: ' + asks.join(' | '));
        assert.ok(asks[0].includes('data-ov-ask="About the forum thread “How do I &lt;b&gt;embed&lt;/b&gt; comments?” (https://openvibe.community/forum/general/how-do-i-b-embed-b-comments): "'), asks[0]);
        assert.ok(asks[0].includes('class="ovk-ask ovk-btn'), 'the shared kit chip');
        assert.ok(!asks[0].includes('<b>'), 'the title is escaped in the chip');
        has(r.text, '/shared/kit.css', 'the kit’s look is on the page');
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
        has(r.text, '<h1><i class="fa-solid fa-thumbtack" title="Pinned" aria-hidden="true"></i><span class="sr-only">Pinned</span> <i class="fa-solid fa-lock" title="Locked" aria-hidden="true"></i><span class="sr-only">Locked</span> ');
        assert.ok(!r.text.includes('aria-label="Pinned"'), 'the pin does not carry an aria-label on an icon');
        const list = await t.get('/forum/general');
        has(list.text, '<i class="fa-solid fa-thumbtack" title="Pinned" aria-hidden="true"></i><span class="sr-only">Pinned</span>');
        assert.ok(!list.text.includes('aria-label="Pinned"'), 'the list pin does not carry an aria-label either');
        const admin = await t.get(url, as(adminJwt));
        has(admin.text, 'Unpin');
        has(admin.text, 'Unlock');
        const mine = await t.get('/forum/general/new', as(samJwt, form({ title: 'Short lived', body: 'x' })));
        const mineUrl = mine.headers.get('location');
        assert.strictEqual((await t.get(`${mineUrl}/delete`, as(alexJwt, form({})))).status, 403);
        const del = await t.get(`${mineUrl}/delete`, as(samJwt, form({})));
        assert.strictEqual(del.status, 303);
        assert.strictEqual(del.headers.get('location'), '/forum/general');
        assert.strictEqual((await t.get(mineUrl)).status, 404);
    });

    await check('space page: hot/new/top tabs as links, server pagination with rel=prev/next and canonical', async () => {
        const space = await forumStore.getSpace(t.db, 'showcase');
        for (let i = 1; i <= 27; i++) await forumStore.createThread(t.db, { space_id: space.id, title: `Showcase item ${i}`, author_subject: alex.subject_id, body_markdown: `item ${i}` });
        const p1 = await t.get('/forum/showcase?sort=new');
        assert.strictEqual(p1.status, 200);
        has(p1.text, '<link rel="canonical" href="https://openvibe.community/forum/showcase?sort=new">');
        has(p1.text, 'href="/forum/showcase"');
        has(p1.text, 'href="/forum/showcase?sort=top"');
        has(p1.text, 'rel="next" href="/forum/showcase?sort=new&amp;page=2"');
        has(p1.text, 'Page 1 of 2');
        assert.strictEqual((p1.text.match(/class="thread-row"/g) || []).length, 25);
        const p2 = await t.get('/forum/showcase?sort=new&page=2');
        has(p2.text, 'rel="prev" href="/forum/showcase?sort=new"');
        has(p2.text, '<link rel="canonical" href="https://openvibe.community/forum/showcase?sort=new&amp;page=2">');
        has(p2.text, 'Showcase item 1<');
        assert.strictEqual((await t.get('/forum/showcase?page=9')).status, 404);
        assert.strictEqual((await t.get('/forum/nowhere')).status, 404);
    });

    await check('members and staff spaces: sign-in redirect, noindex for members, 404 for non-staff; never in feeds or sitemap', async () => {
        await t.db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members'), ('mods', 'Mods', 'staff')").run();
        const ins = await forumStore.getSpace(t.db, 'insiders');
        await forumStore.createThread(t.db, { space_id: ins.id, title: 'Members only chat', author_subject: alex.subject_id, body_markdown: 'psst' });
        const anon = await t.get('/forum/insiders');
        assert.strictEqual(anon.status, 303);
        assert.strictEqual(anon.headers.get('location'), '/auth/login?next=%2Fforum%2Finsiders');
        const member = await t.get('/forum/insiders', as(samJwt));
        assert.strictEqual(member.status, 200);
        has(member.text, '<meta name="robots" content="noindex,nofollow">');
        const th = await t.get('/forum/insiders/members-only-chat', as(samJwt));
        has(th.text, '<meta name="robots" content="noindex,nofollow">');
        assert.strictEqual((await t.get('/forum/mods', as(samJwt))).status, 404);
        assert.strictEqual((await t.get('/forum/mods', as(adminJwt))).status, 200);
        const feed = await t.get('/forum/feed.xml');
        assert.ok(!feed.text.includes('Members only chat'));
        assert.strictEqual((await t.get('/forum/insiders/feed.xml')).status, 404);
        require('../server/discovery').resetCaches();
        const map = await t.get('/sitemap.xml');
        assert.ok(!map.text.includes('members-only-chat'));
    });

    await check('AI threads are labelled as AI on the page and in JSON-LD (never a person)', async () => {
        const space = await forumStore.getSpace(t.db, 'feedback');
        await forumStore.createThread(t.db, { space_id: space.id, title: 'Weekly summary', origin: 'ai', body_markdown: 'What people asked for.' });
        const r = await t.get('/forum/feedback/weekly-summary');
        has(r.text, 'OpenVibe AI');
        has(r.text, '<span class="badge badge-ai"');
        assert.deepStrictEqual(ld(r.text).find((o) => o['@type'] === 'DiscussionForumPosting').author, { '@type': 'Organization', name: 'OpenVibe AI' });
    });

    await check('sitemap, feeds and robots.txt include the forum', async () => {
        require('../server/discovery').resetCaches();
        const map = await t.get('/sitemap.xml');
        for (const loc of ['/forum', '/forum/general', '/pulse', url]) has(map.text, `<loc>https://openvibe.community${loc}</loc>`);
        const feed = await t.get('/forum/feed.xml');
        assert.strictEqual(feed.status, 200);
        has(feed.text, '<rss version="2.0"');
        has(feed.text, `<link>https://openvibe.community${url}</link>`);
        has(feed.text, '<title>How do I &lt;b&gt;embed&lt;/b&gt; comments?</title>');
        const spaceFeed = await t.get('/forum/showcase/feed.xml');
        has(spaceFeed.text, 'Showcase item 27');
        assert.ok(!spaceFeed.text.includes('embed'));
        const robots = await t.get('/robots.txt');
        has(robots.text, 'Disallow: /forum/*/new');
    });

    await t.close();
    done();
})();
