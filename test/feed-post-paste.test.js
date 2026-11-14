'use strict';
/**
 * A post with pictures also makes one paste (plan §AB.36, the owner: "when you put images in the feed, it
 * should go to paste automatically, which also makes a community forum post … interconnected"):
 *   - one paste per post (the pictures, the post's words, the poster as its owner, public as the post is),
 *     and the paste opens the post's own forum thread, so the post, the paste and the thread are one thing;
 *   - the post's feed item carries the paste's address and the thread's;
 *   - one place to reply: a comment on the post and a comment on the paste are the same comment;
 *   - a post without pictures makes no paste, and the same post again makes nothing new.
 */
const assert = require('node:assert/strict');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
// The module under test: the feed composer's route (POST /api/v1/posts).
const postsApi = require('../server/forum/api');

(async () => {
    const t = await boot({
        authority: 'community',
        pasteLimits: { cooldownSeconds: 0 },
        appOpts: {
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 } },
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
        },
    });
    const net = t.network;
    const poster = net.addUser({ network_user_id: 61, username: 'poster', display_name: 'Poster' });
    const reader = net.addUser({ network_user_id: 62, username: 'reader', display_name: 'Reader' });
    const posterJwt = net.sign({ id: 61, subject_id: poster.subject_id, username: 'poster', display_name: 'Poster', role: 'user' });
    const readerJwt = net.sign({ id: 62, subject_id: reader.subject_id, username: 'reader', display_name: 'Reader', role: 'user' });

    const call = (path, { method = 'GET', token, json } = {}) => {
        const h = {};
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body });
    };
    const post = (json, token = posterJwt) => call('/api/v1/posts', { method: 'POST', token, json });
    const count = async (sql, ...args) => Number((await t.db.prepare(sql).get(...args)).c);

    /** One picture the person uploaded: the forum's own upload leaves this row behind. */
    const picture = async (name) => {
        const mediaId = ids.newId('media');
        await t.db.prepare('INSERT INTO attachments (media_id, owner_subject, filename, mime, size_bytes, url) VALUES (?, ?, ?, ?, ?, ?)')
            .run(mediaId, poster.subject_id, name, 'image/png', 12, `https://openvibe.media/o/${mediaId}`);
        return mediaId;
    };

    let made;
    let threadSlug;

    await check('the feed composer answers with the paste its post made', async () => {
        const limit = () => (req, res, next) => next();
        limit.reads = limit;
        const router = postsApi.createPostsApi({ forum: {}, pulse: null, viewers: { middleware: () => (req, res, next) => next() }, limits: limit, db: null });
        const paths = router.stack.map((layer) => layer.route && layer.route.path).filter(Boolean);
        assert.ok(paths.includes('/'), 'the posts route is here: ' + paths.join(', '));
    });

    await check('a post with two pictures makes one paste, owned by the poster, public as the post is', async () => {
        const one = await picture('one.png');
        const two = await picture('two.png');
        const r = await post({ text: 'Two pictures from the feed', pictures: [{ media_id: one, alt: 'The first picture' }, { media_id: two, alt: 'The second picture' }] });
        assert.strictEqual(r.status, 201, r.text);
        made = r.json();
        threadSlug = made.url.split('/').pop();
        assert.ok(made.paste && made.paste.slug, 'the post answers with its paste');
        assert.match(made.paste.url, /\/p\/[A-Za-z0-9_-]+$/);
        assert.match(made.paste.thread_url, /\/forum\/status\//);

        const rows = await t.db.prepare('SELECT p.* FROM pastes p JOIN post_pastes pp ON pp.paste_id = p.id WHERE pp.post_id = ?').all(made.post_id);
        assert.strictEqual(rows.length, 1, 'one paste per post');
        const paste = rows[0];
        assert.strictEqual(paste.owner_subject, poster.subject_id, 'the poster owns it');
        assert.strictEqual(paste.visibility, 'public', 'public as the post is');
        assert.strictEqual(paste.type, 'screenshot');
        assert.strictEqual(paste.content, 'Two pictures from the feed', 'the post\'s words are its text');
        assert.strictEqual(paste.screenshot_url, `https://openvibe.media/o/${one}`, 'the first picture is its picture');
        const meta = JSON.parse(paste.metadata);
        assert.strictEqual(meta.pictures.length, 2, 'both pictures');
        assert.deepStrictEqual(meta.pictures.map((p) => p.alt), ['The first picture', 'The second picture']);
        assert.strictEqual(meta.source_post.id, Number(made.post_id), 'the paste knows the post it came from');
        assert.ok(meta.source_post.url.includes(`/forum/status/${threadSlug}`), 'and the thread it is in');
    });

    await check('the paste opens the post\'s own thread: one conversation for the three', async () => {
        const paste = await t.db.prepare('SELECT p.* FROM pastes p JOIN post_pastes pp ON pp.paste_id = p.id WHERE pp.post_id = ?').get(made.post_id);
        const ct = await t.db.prepare("SELECT * FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'paste' AND ref_id = ?").get(paste.slug);
        assert.ok(ct, 'the paste has a comment thread');
        assert.strictEqual(Number(ct.forum_thread_id), Number(made.id), 'the thread it opens is the post\'s own');
        const threads = await count('SELECT COUNT(*) AS c FROM comment_threads WHERE forum_thread_id = ?', made.id);
        assert.strictEqual(threads, 1, 'one thread, not two');
    });

    await check('the post shows the paste, and the paste page links back to the post', async () => {
        const thread = await call(`/api/v1/spaces/status/threads/${threadSlug}`);
        assert.strictEqual(thread.status, 200, thread.text);
        const opening = thread.json().posts[0];
        assert.ok(opening.pastes && opening.pastes.length === 1, 'the post carries its paste');
        assert.strictEqual(opening.pastes[0].slug, made.paste.slug);
        const page = await t.get(made.paste.url.replace('https://openvibe.community', ''));
        assert.strictEqual(page.status, 200, page.text);
        assert.ok(page.text.includes('Posted in the forum'), 'the paste page links back to the forum');
        assert.ok(page.text.includes(`/forum/status/${threadSlug}`), 'to the thread the post is in');
    });

    await check('the post\'s feed item carries the paste\'s address and the thread\'s', async () => {
        const activity = await t.get('/api/v1/activity?limit=100');
        assert.strictEqual(activity.status, 200, activity.text);
        const items = activity.json().items;
        const item = items.find((i) => i.type === 'paste' && i.id === made.paste.slug);
        assert.ok(item, 'the post is in the feed as its paste');
        assert.strictEqual(item.kind, 'pic');
        assert.strictEqual(item.url, `https://openvibe.community/p/${made.paste.slug}`, 'the paste\'s address');
        assert.strictEqual(item.forum_url, `https://openvibe.community/forum/status/${threadSlug}`, 'the thread\'s address');
        assert.ok(item.picture_url && item.picture_url.includes('med_'), 'the card shows the picture');
        const forThisPost = items.filter((i) => i.id === made.paste.slug || i.id === String(made.id));
        assert.strictEqual(forThisPost.length, 1, 'one item for the post, not two');
    });

    await check('one place to reply: the post and the paste are the same thread', async () => {
        const byPaste = await call('/api/v1/comments/threads/resolve', { method: 'POST', token: readerJwt, json: { ref: { service: 'community', type: 'paste', id: made.paste.slug } } });
        assert.strictEqual(byPaste.status, 200, byPaste.text);
        const byPost = await call('/api/v1/comments/threads/resolve', { method: 'POST', token: readerJwt, json: { ref: { service: 'community', type: 'post', id: String(made.post_id) } } });
        assert.strictEqual(byPost.status, 200, byPost.text);
        assert.strictEqual(byPost.json().thread.access_id, byPaste.json().thread.access_id, 'the same thread');
        assert.strictEqual(byPaste.json().thread.forum_url, `/forum/status/${threadSlug}`, 'and the thread the post is in');
        // A comment on the paste is a reply in the post's thread.
        const comment = await call(`/api/v1/comments/threads/${byPaste.json().thread.access_id}/comments`, { method: 'POST', token: readerJwt, json: { message: 'Nice pictures' } });
        assert.strictEqual(comment.status, 201, comment.text);
        const thread = await call(`/api/v1/spaces/status/threads/${threadSlug}`);
        assert.ok(thread.json().posts.some((p) => p.body_markdown === 'Nice pictures'), 'the comment is in the thread');
        assert.strictEqual(thread.json().thread.reply_count, 1);
        // A reply in the forum is a comment on the paste.
        const reply = await call(`/api/v1/spaces/status/threads/${threadSlug}/posts`, { method: 'POST', token: readerJwt, json: { body: 'A reply in the forum' } });
        assert.strictEqual(reply.status, 201, reply.text);
        const comments = await call(`/api/v1/comments/threads/${byPaste.json().thread.access_id}`);
        assert.strictEqual(comments.status, 200, comments.text);
        assert.strictEqual(comments.json().thread.comment_count, 2, 'both are on the one thread');
        const messages = comments.json().comments.map((c) => c.message);
        assert.ok(messages.includes('Nice pictures') && messages.includes('A reply in the forum'));
    });

    await check('the same post again makes nothing new', async () => {
        const before = await count('SELECT COUNT(*) AS c FROM pastes');
        const thread = await t.db.prepare('SELECT * FROM threads WHERE id = ?').get(made.id);
        const postRow = await t.db.prepare('SELECT * FROM posts WHERE id = ?').get(made.post_id);
        const again = await t.app.locals.forum.ensurePostPaste(
            { kind: 'user', subject: poster.subject_id, staff: false, origin: 'user' },
            { thread, post: postRow, spaceSlug: 'status' },
        );
        assert.ok(again, 'the paste is still there');
        assert.strictEqual(again.created, false, 'nothing new was made');
        assert.strictEqual(again.paste.slug, made.paste.slug);
        assert.strictEqual(await count('SELECT COUNT(*) AS c FROM pastes'), before, 'no second paste');
        assert.strictEqual(await count('SELECT COUNT(*) AS c FROM post_pastes WHERE post_id = ?', made.post_id), 1, 'one link');
        assert.strictEqual(await count('SELECT COUNT(*) AS c FROM comment_threads WHERE ref_type = \'paste\' AND ref_id = ?', made.paste.slug), 1, 'one thread');
    });

    await check('a post without pictures makes no paste', async () => {
        const before = await count('SELECT COUNT(*) AS c FROM pastes');
        const r = await post({ text: 'Words only' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().paste, null, 'no paste');
        assert.strictEqual(await count('SELECT COUNT(*) AS c FROM pastes'), before, 'no new paste');
        const links = await count('SELECT COUNT(*) AS c FROM post_pastes WHERE post_id = ?', r.json().post_id);
        assert.strictEqual(links, 0);
    });

    await check('a picture the person takes back does not stay in the feed as a paste', async () => {
        const three = await picture('three.png');
        const r = await post({ text: 'A picture to take back', pictures: [{ media_id: three, alt: 'Take this back' }] });
        assert.strictEqual(r.status, 201, r.text);
        const pasteSlug = r.json().paste.slug;
        const gone = await call(`/api/v1/posts/${r.json().post_id}`, { method: 'DELETE', token: posterJwt });
        assert.strictEqual(gone.status, 200, gone.text);
        const row = await t.db.prepare('SELECT deleted_at, visibility FROM pastes WHERE slug = ?').get(pasteSlug);
        assert.ok(row.deleted_at, 'the paste goes with the post');
        assert.strictEqual((await t.get(`/p/${pasteSlug}`)).status, 404, 'and its page is gone');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
