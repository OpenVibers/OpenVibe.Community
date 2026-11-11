'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: {
        commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
        forumLimits: { posts: { cooldownSec: 0, perMinute: 1000 } },
    } });
    const person = t.network.addUser({ network_user_id: 71, username: 'threader', display_name: 'Threader' });
    const cookie = t.network.sign({ id: 71, subject_id: person.subject_id, username: 'threader', display_name: 'Threader', role: 'user' });
    const call = (url, method = 'GET', json = null) => t.get(url, {
        method, headers: json == null ? {} : { 'content-type': 'application/json' },
        body: json == null ? undefined : JSON.stringify(json), cookies: [`ov_token=${cookie}`],
    });
    const create = async (visibility) => {
        const response = await call('/api/pastes', 'POST', { title: 'A pictured paste', content: `hello ${visibility} ${Math.random()}`, visibility });
        assert.strictEqual(response.status, 201, response.text);
        return response.json().slug;
    };

    await check('a public item enters its board on first comment and forum replies share the comment', async () => {
        const slug = await create('public');
        const resolved = await call('/api/v1/comments/threads/resolve', 'POST', { ref: { service: 'community', type: 'paste', id: slug } });
        const access = resolved.json().thread.id;
        const before = await call('/api/v1/spaces/pastes/threads');
        assert.strictEqual(before.json().threads.length, 0);
        const first = await call(`/api/v1/comments/threads/${access}/comments`, 'POST', { message: 'From the paste' });
        assert.strictEqual(first.status, 201, first.text);
        const row = await t.db.prepare('SELECT id, forum_thread_id FROM comment_threads WHERE access_id = ?').get(access);
        assert.ok(row.forum_thread_id);
        const url = `/api/v1/spaces/pastes/threads/item-${row.id}`;
        const forum = await call(url);
        assert.strictEqual(forum.status, 200, forum.text);
        assert.strictEqual(forum.json().posts[1].body_markdown, 'From the paste');
        const canonical = await require('../server/pastes/store').canonicalForRef(t.db, slug);
        assert.ok((await call(`/p/${canonical}`)).text.includes(`/forum/pastes/item-${row.id}`));
        const reply = await call(`${url}/posts`, 'POST', { body: 'From the forum' });
        assert.strictEqual(reply.status, 201, reply.text);
        const comments = await call(`/api/v1/comments/threads/${access}`);
        assert.deepStrictEqual(comments.json().comments.map((c) => c.message), ['From the paste', 'From the forum']);
        const postId = reply.json().post.id;
        const edited = await call(`/api/v1/posts/${postId}`, 'PUT', { body: 'Edited in the forum' });
        assert.strictEqual(edited.status, 200, edited.text);
        assert.ok((await call(`/api/v1/comments/threads/${access}`)).text.includes('Edited in the forum'));
        const privateResult = await call(`/api/pastes/${slug}`, 'PUT', { visibility: 'private' });
        assert.strictEqual(privateResult.status, 200, privateResult.text);
        assert.strictEqual((await call(url)).status, 404);
        assert.strictEqual((await call('/api/v1/spaces/pastes/threads')).json().threads.length, 0);
    });

    await check('unlisted comments stay off the public board', async () => {
        const slug = await create('unlisted');
        const resolved = await call('/api/v1/comments/threads/resolve', 'POST', { ref: { service: 'community', type: 'paste', id: slug } });
        const created = await call(`/api/v1/comments/threads/${resolved.json().thread.id}/comments`, 'POST', { message: 'Link only' });
        assert.strictEqual(created.status, 201, created.text);
        assert.strictEqual((await t.db.prepare('SELECT forum_thread_id FROM comment_threads WHERE access_id = ?').get(resolved.json().thread.id)).forum_thread_id, null);
    });

    await check('backfill preserves old comment ids and timestamps and is repeatable', async () => {
        const slug = await create('public');
        const resolved = await call('/api/v1/comments/threads/resolve', 'POST', { ref: { service: 'community', type: 'paste', id: slug } });
        const thread = await t.db.prepare('SELECT id FROM comment_threads WHERE access_id = ?').get(resolved.json().thread.id);
        const first = await t.db.prepare("INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, 'Older', '2025-01-01 01:00:00') RETURNING id").run(thread.id, person.subject_id);
        const second = await t.db.prepare("INSERT INTO comments (thread_id, author_subject, message, created_at) VALUES (?, ?, 'Newer', '2025-01-01 02:00:00') RETURNING id").run(thread.id, person.subject_id);
        const sql = fs.readFileSync(path.join(__dirname, '../migrations/0034_comment_forum_backfill.sql'), 'utf8');
        await t.db.exec(sql);
        await t.db.exec(sql);
        const rows = await t.db.prepare('SELECT comment_id, created_at FROM posts WHERE comment_id IN (?, ?) ORDER BY id').all(first.lastInsertRowid, second.lastInsertRowid);
        assert.deepStrictEqual(rows.map((r) => r.comment_id), [first.lastInsertRowid, second.lastInsertRowid]);
        assert.deepStrictEqual(rows.map((r) => r.created_at), ['2025-01-01 01:00:00', '2025-01-01 02:00:00']);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
