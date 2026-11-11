'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    let visibility = 'public';
    let listed = true;
    const pictureId = 'pic_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const fetchImpl = async (url, options) => {
        const text = String(url);
        if (text === 'https://openvibe.live/api/vods/555') return new Response(JSON.stringify({ vod: {
            id: 555, title: 'A public recording', visibility, thumbnail_url: 'https://openvibe.media/o/med_example', username: 'maker',
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (text === 'https://openvibe.live/api/clips/556') return new Response(JSON.stringify({ clip: {
            id: 556, title: 'An unlisted clip', visibility: 'unlisted',
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
        if (text === `https://openvibe.pics/api/v1/pictures/${pictureId}`) return new Response(JSON.stringify({
            id: pictureId, slug: 'listed-picture', title: 'Listed picture', listed, state: 'active', views: 0,
            url: 'https://openvibe.pics/i/listed-picture/full.jpg',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        return fetch(url, options);
    };
    const t = await boot({ authority: 'community', appOpts: { fetchImpl, commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } } } });
    const person = t.network.addUser({ network_user_id: 81, username: 'viewer', display_name: 'Viewer' });
    const service = t.network.signService({ cap: ['community.comment.write'] });
    const call = (url, method = 'GET', json = null, headers = {}) => t.get(url, {
        method, headers: { ...(json == null ? {} : { 'content-type': 'application/json' }), ...headers },
        body: json == null ? undefined : JSON.stringify(json),
    });
    const resolve = (type, id) => call('/api/v1/comments/threads/resolve', 'POST', { ref: { service: 'live', type, id } }, { authorization: `Bearer ${service}` });

    await check('a public recording opens a Videos thread and its forum view follows visibility', async () => {
        const resolved = await resolve('vod', '555');
        assert.strictEqual(resolved.status, 201, resolved.text);
        const access = resolved.json().thread.id;
        const before = await call('/api/v1/spaces/videos/threads');
        assert.deepStrictEqual(before.json().threads, []);
        const added = await call(`/api/v1/comments/threads/${access}/comments`, 'POST', { message: 'Recorded moment' },
            { authorization: `Bearer ${service}`, 'x-ov-subject': person.subject_id });
        assert.strictEqual(added.status, 201, added.text);
        const row = await t.db.prepare('SELECT id, forum_thread_id FROM comment_threads WHERE access_id = ?').get(access);
        assert.ok(row.forum_thread_id);
        const forum = await call(`/api/v1/spaces/videos/threads/item-${row.id}`);
        assert.strictEqual(forum.status, 200, forum.text);
        assert.strictEqual(forum.json().posts[1].body_markdown, 'Recorded moment');
        assert.ok(forum.json().posts[0].body_markdown.includes('openvibe.video/v/555'));
        assert.strictEqual((await call('/api/v1/spaces/videos/threads')).json().threads.length, 1);
        visibility = 'private';
        assert.deepStrictEqual((await call('/api/v1/spaces/videos/threads')).json().threads, []);
        assert.strictEqual((await call(`/api/v1/spaces/videos/threads/item-${row.id}`)).status, 404);
        const whilePrivate = await call(`/api/v1/comments/threads/${access}/comments`, 'POST', { message: 'Written while private' },
            { authorization: `Bearer ${service}`, 'x-ov-subject': person.subject_id });
        assert.strictEqual(whilePrivate.status, 201, whilePrivate.text);
        visibility = 'public';
        const restored = await call(`/api/v1/spaces/videos/threads/item-${row.id}`);
        assert.strictEqual(restored.status, 200);
        assert.ok(restored.text.includes('Written while private'));
    });

    await check('an unlisted clip can have comments but enters no public board', async () => {
        const resolved = await resolve('clip', '556');
        const added = await call(`/api/v1/comments/threads/${resolved.json().thread.id}/comments`, 'POST', { message: 'Link-only moment' },
            { authorization: `Bearer ${service}`, 'x-ov-subject': person.subject_id });
        assert.strictEqual(added.status, 201, added.text);
        assert.strictEqual((await t.db.prepare('SELECT forum_thread_id FROM comment_threads WHERE access_id = ?').get(resolved.json().thread.id)).forum_thread_id, null);
        assert.deepStrictEqual((await call('/api/v1/spaces/clips/threads')).json().threads, []);
    });
    await check('a listed picture enters Pictures and disappears when unlisted', async () => {
        const resolved = await call('/api/v1/comments/threads/resolve', 'POST', { ref: { service: 'pics', type: 'picture', id: pictureId } },
            { authorization: `Bearer ${service}` });
        assert.strictEqual(resolved.status, 201, resolved.text);
        const added = await call(`/api/v1/comments/threads/${resolved.json().thread.id}/comments`, 'POST', { message: 'Picture discussion' },
            { authorization: `Bearer ${service}`, 'x-ov-subject': person.subject_id });
        assert.strictEqual(added.status, 201, added.text);
        const row = await t.db.prepare('SELECT id FROM comment_threads WHERE access_id = ?').get(resolved.json().thread.id);
        const url = `/api/v1/spaces/pictures/threads/item-${row.id}`;
        assert.strictEqual((await call(url)).status, 200);
        assert.strictEqual((await call('/api/v1/spaces/pictures/threads')).json().threads.length, 1);
        listed = false;
        assert.strictEqual((await call(url)).status, 404);
        assert.deepStrictEqual((await call('/api/v1/spaces/pictures/threads')).json().threads, []);
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
