'use strict';
/**
 * Forum style and the features both styles share: the board index (groups, child boards, topics, posts,
 * last post), a forum-style board (topic table, Replies/Views/Last post, sticky first, bumped by replies),
 * topics with author panels and Quote, per-space votes and ratings, Facepunch-style ratings (one per
 * person per post, toggle, replace, not your own, off per space, totals on the author panel), pastes on
 * posts (cards, private and burn-after-read refused), crossposts between a forum and a feed, "Discuss in
 * a space" from a paste, space settings and new spaces (moderators only).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const modJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'global_mod' });
    const call = (path, { method = 'GET', cookie, json, form } = {}) => {
        const h = {};
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const pasteRow = (slug, extra = {}) => t.db.prepare('INSERT INTO pastes (slug, owner_subject, title, content, language, visibility, burn_after_read) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(slug, alex.subject_id, extra.title || 'Snippet', extra.content || 'const a = 1;\nconsole.log(a);', 'javascript', extra.visibility || 'public', extra.burn ? 1 : 0);

    let topic;
    await check('a forum topic: votes off, a topic row with replies, views and the last post', async () => {
        let r = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Welcome thread', body: 'Say hi.' } });
        assert.strictEqual(r.status, 201, r.text);
        topic = r.json().thread;
        r = await call('/api/v1/spaces/general/threads/welcome-thread/posts', { method: 'POST', cookie: samJwt, json: { body: 'hi from sam' } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual((await call('/api/v1/spaces/general/threads/welcome-thread/votes', { method: 'POST', cookie: samJwt, json: { value: 1 } })).json().code, 'space.votes_off');
        await call('/s/general/t/welcome-thread', { cookie: samJwt });
        await call('/s/general/t/welcome-thread', { cookie: samJwt });
        await call('/s/general/t/welcome-thread', { cookie: alexJwt });
        const list = (await call('/api/v1/spaces/general/threads')).json();
        assert.strictEqual(list.sort, 'active', 'forum boards list the newest reply first');
        const row = list.threads[0];
        assert.strictEqual(row.views, 2, 'one view per viewer per half hour');
        assert.strictEqual(row.last_post.author.username, 'sam');
        const page = (await call('/s/general')).text;
        assert.ok(page.includes('class="board-table topic-table"') && page.includes('data-label="Views"') && page.includes('Started by Alex'));
        assert.ok(!page.includes('class="thread-score"'), 'no score column');
    });

    await check('the board index: groups in order, every space with topics, posts and the last post', async () => {
        const r = (await call('/api/v1/spaces')).json();
        const general = r.groups[0].spaces.find((s) => s.slug === 'general');
        assert.strictEqual(general.thread_count, 1); assert.strictEqual(general.post_count, 2);
        assert.strictEqual(general.last_post.thread.title, 'Welcome thread'); assert.strictEqual(general.last_post.author.username, 'sam');
        const html = (await call('/s')).text;
        assert.ok(html.includes('id="g-openvibe"') && html.includes('id="g-community"') && html.includes('Off-topic') && html.includes('badge-style">Forum') && html.includes('badge-style">Feed'));
    });

    await check('ratings: one per person per post, toggle, replace, not your own; totals on the author panel', async () => {
        const post = (await call('/api/v1/spaces/general/threads/welcome-thread')).json().posts[0];
        const rate = (cookie, reaction) => call(`/api/v1/posts/${post.id}/reactions`, { method: 'POST', cookie, json: { reaction } });
        assert.strictEqual((await rate(alexJwt, 'winner')).json().code, 'reaction.own_post');
        let r = await rate(samJwt, 'winner');
        assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json().mine, 'winner');
        r = await rate(modJwt, 'winner');
        assert.deepStrictEqual(r.json().reactions.map((x) => [x.key, x.count]), [['winner', 2]]);
        r = await rate(samJwt, 'late');
        assert.deepStrictEqual(r.json().reactions.map((x) => [x.key, x.count]), [['winner', 1], ['late', 1]], 'another rating replaces yours');
        r = await rate(samJwt, 'late');
        assert.strictEqual(r.json().mine, null, 'the same one again takes it back');
        assert.strictEqual((await rate(samJwt, 'amazing')).status, 400);
        assert.strictEqual((await rate(null, 'agree')).status, 401);
        const page = (await call('/api/v1/spaces/general/threads/welcome-thread', { cookie: samJwt })).json();
        assert.deepStrictEqual(page.posts[0].reactions.map((x) => [x.key, x.count, x.raters]), [['winner', 1, ['Boss']]]);
        assert.deepStrictEqual(page.posts[0].author_stats.ratings.map((x) => [x.key, x.count]), [['winner', 1]]);
        assert.strictEqual(page.posts[0].can_react, true); assert.strictEqual(page.posts[1].can_react, false, 'sam cannot rate their own reply');
        const html = (await call('/s/general/t/welcome-thread', { cookie: samJwt })).text;
        assert.ok(html.includes('class="postbit') && html.includes('postbit-author') && html.includes('<dt>Posts</dt>') && html.includes('Rate</summary>') && html.includes('🏆'));
        r = await call('/s/general/t/welcome-thread/react', { method: 'POST', cookie: samJwt, form: { post: String(post.id), reaction: 'funny' } });
        assert.strictEqual(r.status, 303); assert.ok(r.headers.get('location').endsWith(`#post-${post.id}`));
        t.db.prepare("UPDATE spaces SET reactions = 0 WHERE slug = 'general'").run();
        assert.strictEqual((await rate(samJwt, 'agree')).json().code, 'space.reactions_off');
        assert.deepStrictEqual((await call('/api/v1/spaces/general/threads/welcome-thread')).json().posts[0].reactions, []);
        t.db.prepare("UPDATE spaces SET reactions = 1 WHERE slug = 'general'").run();
    });

    await check('quote: ?quote= fills the reply box with the quoted post', async () => {
        const post = (await call('/api/v1/spaces/general/threads/welcome-thread')).json().posts[1];
        const html = (await call(`/s/general/t/welcome-thread?quote=${post.id}`, { cookie: alexJwt })).text;
        assert.ok(html.includes('**@sam** wrote:\n&gt; hi from sam'), 'the quote is in the reply box');
    });

    await check('pastes on posts: public and unlisted as cards; private and burn-after-read refused', async () => {
        pasteRow('snip1'); pasteRow('snip2', { visibility: 'unlisted', title: 'Hidden-ish' }); pasteRow('secret1', { visibility: 'private' }); pasteRow('burn1', { burn: true });
        let r = await call('/api/v1/spaces/general/threads/welcome-thread/posts', { method: 'POST', cookie: samJwt, json: { body: 'look at these', pastes: 'https://openvibe.community/p/snip1 snip2' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(r.json().post.pastes.map((p) => [p.slug, p.lines]), [['snip1', 2], ['snip2', 2]]);
        for (const bad of ['secret1', 'burn1']) assert.strictEqual((await call('/api/v1/spaces/general/threads/welcome-thread/posts', { method: 'POST', cookie: samJwt, json: { body: 'x', pastes: [bad] } })).json().code, 'pastes.not_shareable');
        assert.strictEqual((await call('/api/v1/spaces/general/threads/welcome-thread/posts', { method: 'POST', cookie: samJwt, json: { body: 'x', pastes: ['nope-nope'] } })).status, 404);
        const html = (await call('/s/general/t/welcome-thread')).text;
        assert.ok(html.includes('class="paste-embed"') && html.includes('href="/p/snip1"') && html.includes('hljs'));
        t.db.prepare("UPDATE pastes SET visibility = 'private' WHERE slug = 'snip2'").run();
        const after = (await call('/api/v1/spaces/general/threads/welcome-thread')).json().posts.find((p) => p.body_markdown === 'look at these');
        assert.deepStrictEqual(after.pastes.map((p) => p.slug), ['snip1'], 'a paste made private drops out');
    });

    await check('"Discuss in a space" from a paste: the picker, then a new topic with the paste attached', async () => {
        const paste = (await call('/p/snip1')).text;
        assert.ok(paste.includes('/s/discuss?paste=snip1'));
        const picker = (await call('/s/discuss?paste=snip1', { cookie: alexJwt })).text;
        assert.ok(picker.includes('/s/general/new?paste=snip1') && !picker.includes('/s/roadmap/new'));
        const form = (await call('/s/general/new?paste=snip1', { cookie: alexJwt })).text;
        assert.ok(form.includes('name="pastes"') && form.includes('value="snip1"') && form.includes('value="Snippet"'));
    });

    await check('crosspost: a forum topic into a feed, both linked; members-only never', async () => {
        const r = await call('/api/v1/spaces/general/threads/welcome-thread/crosspost', { method: 'POST', cookie: samJwt, json: { to: 'showcase' } });
        assert.strictEqual(r.status, 201, r.text);
        const cp = r.json().thread;
        assert.strictEqual(cp.space, 'showcase'); assert.strictEqual(cp.crosspost_of, topic.id);
        const there = (await call(`/api/v1/spaces/showcase/threads/${cp.slug}`)).json();
        assert.strictEqual(there.crosspost.from.url, '/s/general/t/welcome-thread');
        assert.ok(there.posts[0].body_markdown.startsWith('Crossposted from **General**'));
        const here = (await call('/api/v1/spaces/general/threads/welcome-thread', { cookie: samJwt })).json();
        assert.deepStrictEqual(here.crosspost.to.map((x) => x.space), ['Showcase']);
        assert.ok(here.crosspost.targets.some((x) => x.slug === 'showcase') && !here.crosspost.targets.some((x) => x.slug === 'roadmap' || x.slug === 'general'));
        assert.strictEqual((await call('/api/v1/spaces/general/threads/welcome-thread/crosspost', { method: 'POST', cookie: samJwt, json: { to: 'roadmap' } })).status, 403);
        const html = (await call('/s/general/t/welcome-thread', { cookie: samJwt })).text;
        assert.ok(html.includes('Also in') && html.includes('Crosspost</summary>'));
    });

    await check('space settings and new spaces: moderators only; style switches the pages', async () => {
        let r = await call('/api/v1/spaces/showcase/settings', { method: 'PUT', cookie: alexJwt, json: { style: 'forum' } });
        assert.strictEqual(r.status, 403);
        r = await call('/api/v1/spaces/showcase/settings', { method: 'PUT', cookie: modJwt, json: { style: 'forum', votes: false } });
        assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json().space.style, 'forum'); assert.strictEqual(r.json().space.votes, false);
        assert.ok((await call('/s/showcase')).text.includes('topic-table'));
        r = await call('/s/showcase/settings', { method: 'POST', cookie: modJwt, form: { name: 'Showcase', style: 'feed', votes: '1', reactions: '1', group: 'community' } });
        assert.strictEqual(r.status, 303);
        assert.ok((await call('/s/showcase')).text.includes('class="thread-list"'));
        assert.strictEqual((await call('/s/new-space', { cookie: alexJwt })).status, 403);
        r = await call('/s/new-space', { method: 'POST', cookie: modJwt, form: { name: 'Music', slug: 'music', description: 'Songs', style: 'forum', reactions: '1', group: 'community' } });
        assert.strictEqual(r.status, 303); assert.strictEqual(r.headers.get('location'), '/s/music');
        const music = (await call('/api/v1/spaces')).json().spaces.find((s) => s.slug === 'music');
        assert.deepStrictEqual([music.style, music.votes, music.reactions, music.group.slug], ['forum', false, true, 'community']);
        r = await call('/api/v1/spaces/music/settings', { method: 'PUT', cookie: modJwt, json: { parent: 'off-topic' } });
        assert.strictEqual(r.status, 200, r.text);
        const idx = (await call('/api/v1/spaces')).json();
        assert.ok(idx.groups.find((g) => g.slug === 'community').spaces.find((s) => s.slug === 'off-topic').children.some((c) => c.slug === 'music'), 'a child board sits under its parent');
        assert.strictEqual((await call('/api/v1/spaces', { method: 'POST', cookie: modJwt, json: { slug: 'discuss', name: 'Nope' } })).status, 400, 'reserved address');
    });

    await done(t);
})();
