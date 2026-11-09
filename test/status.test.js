'use strict';
const assert = require('node:assert/strict');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0 } } } });
    const person = t.network.addUser({ network_user_id: 91, username: 'statusowner', display_name: 'Status Owner' });
    const token = t.network.sign({ id: 91, subject_id: person.subject_id, username: 'statusowner', role: 'user' });
    const reader = t.network.addUser({ network_user_id: 93, username: 'statusreader', display_name: 'Status Reader' });
    const readerToken = t.network.sign({ id: 93, subject_id: reader.subject_id, username: 'statusreader', role: 'user' });
    const post = (body, auth = token) => t.get('/api/v1/me/status', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
    await check('status is a moderated public opening post and pulse item', async () => {
        assert.equal((await post({ text: 'Hello world' }, null)).status, 401);
        assert.equal((await post({ text: 'bad http://example.test' })).status, 400);
        assert.equal((await post({ text: 'x'.repeat(501) })).status, 400);
        const r = await post({ text: 'Hello world' });
        assert.equal(r.status, 201, r.text);
        const status = r.json();
        assert.equal(status.text, 'Hello world');
        assert.ok(status.post_id && status.url.includes('/forum/status/'));
        const pulse = await t.db.prepare("SELECT * FROM pulse_items WHERE source_service = 'community' AND source_type = 'status' AND source_id = ?").get(String(status.id));
        assert.equal(pulse.actor_subject, person.subject_id);
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
        assert.equal(await t.db.prepare("SELECT * FROM pulse_items WHERE source_service = 'community' AND source_type = 'status' AND source_id = ?").get(String(status.id)), undefined);
    });
    await check('a granted app contributes for its person and can retract only that person\'s item', async () => {
        const { createPulse } = require('../server/pulse/service');
        const pulse = createPulse({ db: t.db, config: { baseUrl: 'https://openvibe.community' } });
        const app = { kind: 'service', service: 'app:app_test', subject: person.subject_id,
            claims: { on_behalf_of: person.subject_id, app_name: 'Demo App' } };
        await assert.rejects(pulse.contribute(app, { id: 'bad', text: 'Bad picture', url: 'https://example.test/thing',
            picture_url: 'https://example.test/image.jpg' }));
        const out = await pulse.contribute(app, { id: 'hello', text: 'Made a new thing', url: 'https://example.test/thing',
            picture_url: 'https://openvibe.media/t/demo.jpg' });
        assert.equal(out.created, true);
        assert.equal(out.item.via, 'via Demo App');
        assert.equal(out.item.picture_url, 'https://openvibe.media/t/demo.jpg');
        assert.equal(out.item.actor.subject, person.subject_id);
        assert.equal((await pulse.retractContribution(app, out.item.source.service, 'contribution', out.item.source.id)).removed, 1);
        await assert.rejects(pulse.retractContribution({ ...app, subject: 'usr_01J00000000000000000000000',
            claims: { on_behalf_of: 'usr_01J00000000000000000000000' } }, out.item.source.service, 'contribution', out.item.source.id));
    });
    await check('the HTTP route accepts a person-granted app token and shows its signed app name', async () => {
        const appId = ids.newId('app');
        const appToken = t.network.signService({ sub: `app:${appId}`, actorType: 'app', cap: ['community.pulse.contribute'],
            extra: { project_id: ids.newId('project'), env: 'production', on_behalf_of: person.subject_id, app_name: 'Demo App' } });
        const response = await t.get('/api/v1/pulse/items', { method: 'POST', headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ id: 'demo-1', text: 'New demo', url: 'https://example.test/demo' }) });
        assert.equal(response.status, 201, response.text);
        assert.equal(response.json().item.via, 'via Demo App');
        assert.equal(response.json().item.actor.subject, person.subject_id);
        const source = response.json().item.source;
        const deleted = await t.get(`/api/v1/pulse/items/${encodeURIComponent(source.service)}/contribution/${encodeURIComponent(source.id)}`, {
            method: 'DELETE', headers: { authorization: `Bearer ${appToken}` } });
        assert.equal(deleted.status, 200, deleted.text);
        assert.equal(deleted.json().removed, 1);
    });
    await check('followed people lead a personal page and its cursor keeps the order', async () => {
        const { createPulse } = require('../server/pulse/service');
        const store = require('../server/pulse/store');
        const followed = t.network.addUser({ network_user_id: 92, username: 'followed', display_name: 'Followed' });
        const now = new Date();
        const at = (ms) => new Date(now.getTime() - ms).toISOString().replace('T', ' ').slice(0, 19);
        await store.upsertItem(t.db, { source_service: 'live', source_type: 'clip', source_id: 'older-followed',
            title: 'followed', url: 'https://openvibe.live/c/f', actor_subject: followed.subject_id, origin: 'user', occurred_at: at(30_000) });
        await store.upsertItem(t.db, { source_service: 'live', source_type: 'clip', source_id: 'newer-other',
            title: 'other', url: 'https://openvibe.live/c/o', actor_subject: person.subject_id, origin: 'user', occurred_at: at(10_000) });
        const pulse = createPulse({ db: t.db, config: { networkInternalUrl: 'https://network.test' },
            fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ target_id: followed.subject_id }], next_cursor: null }) }) });
        const viewer = { kind: 'user', subject: person.subject_id, token: 'user-token' };
        const first = await pulse.list({ for: 'me', limit: 1 }, viewer);
        assert.equal(first.items[0].source.id, 'older-followed');
        assert.deepEqual(first.viewer, { can_post: true }, 'a signed-in reader is told they can post (the menu shows its composer)');
        assert.equal((await pulse.list({ limit: 1 }, null)).viewer, undefined, 'a guest is not');
        const second = await pulse.list({ for: 'me', limit: 1, cursor: first.next_cursor }, viewer);
        assert.notEqual(second.items[0].id, first.items[0].id);
        await assert.rejects(pulse.list({ for: 'me', cursor: Buffer.from(JSON.stringify(['bad', 1, 'time', 2])).toString('base64url') }, viewer));
    });
    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
