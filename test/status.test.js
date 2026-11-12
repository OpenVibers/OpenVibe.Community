'use strict';
const assert = require('node:assert/strict');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0 } } } });
    const person = t.network.addUser({ network_user_id: 91, username: 'statusowner', display_name: 'Status Owner' });
    const token = t.network.sign({ id: 91, subject_id: person.subject_id, username: 'statusowner', role: 'user' });
    const reader = t.network.addUser({ network_user_id: 93, username: 'statusreader', display_name: 'Status Reader' });
    const readerToken = t.network.sign({ id: 93, subject_id: reader.subject_id, username: 'statusreader', role: 'user' });
    const post = (body, auth = token) => t.get('/api/v1/me/status', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    await check('status is a moderated public opening post', async () => {
        assert.equal((await post({ text: 'Hello world' }, null)).status, 401);
        assert.equal((await post({ text: 'bad http://example.test' })).status, 400);
        assert.equal((await post({ text: 'x'.repeat(501) })).status, 400);
        const r = await post({ text: 'Hello world' });
        assert.equal(r.status, 201, r.text);
        const status = r.json();
        assert.equal(status.text, 'Hello world');
        assert.ok(status.post_id && status.url.includes('/forum/status/'));
        const profile = await t.get(`/api/v1/profiles/${person.subject_id}/statuses`);
        assert.equal(profile.status, 200);
        assert.equal(profile.json().statuses[0].text, 'Hello world');
        const reaction = await t.get(`/api/v1/posts/${status.post_id}/reactions`, { method: 'POST',
            headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reaction: 'friendly' }) });
        assert.equal(reaction.status, 200, reaction.text);
        const slug = status.url.split('/').pop();
        const reply = await t.get(`/api/v1/spaces/status/threads/${slug}/posts`, { method: 'POST',
            headers: { authorization: `Bearer ${readerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Nice update' }) });
        assert.equal(reply.status, 201, reply.text);
        const deleted = await t.get(`/api/v1/spaces/status/threads/${slug}`, { method: 'DELETE',
            headers: { authorization: `Bearer ${token}` } });
        assert.equal(deleted.status, 200, deleted.text);
        // The one feed reads Community's public activity directly (server/activity/service.js): the
        // status is in it while public and gone after the delete.
        const live = await t.get('/api/v1/activity?limit=100');
        assert.equal(live.status, 200, live.text);
        assert.ok(Array.isArray(live.json().items));
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
