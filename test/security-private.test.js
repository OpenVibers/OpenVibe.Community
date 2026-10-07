'use strict';
/** Private and burned paste content stays out of public reads and comment threads. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 } });
    const user = t.network.addUser({ network_user_id: 31, username: 'alex' });
    const token = t.network.sign({ id: 31, subject_id: user.subject_id, username: 'alex', role: 'user' });
    const owner = { cookies: [`ov_token=${token}`] };
    const create = async (body) => t.get('/api/pastes', { method: 'POST', ...owner, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const p = await create({ title: 'Secret title', content: 'SECRET_BODY', visibility: 'private' });
    assert.strictEqual(p.status, 201, p.text);
    const slug = p.json().slug;
    await check('private paste reads match an unknown paste for visitors', async () => {
        for (const path of [`/api/pastes/${slug}`, `/p/${slug}`, `/p/${slug}/raw`, `/p/${slug}/download`]) {
            const r = await t.get(path);
            assert.strictEqual(r.status, 404, path);
            assert.ok(!r.text.includes('SECRET_BODY'));
        }
        assert.strictEqual((await t.get(`/api/pastes/${slug}`, owner)).status, 200);
    });
    await check('the typed comment thread follows paste visibility', async () => {
        const ref = { service: 'community', type: 'paste', id: slug };
        const resolve = (opts = {}) => t.get('/api/v1/comments/threads/resolve', { method: 'POST', ...opts, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) });
        assert.strictEqual((await resolve()).status, 404);
        const r = await resolve(owner);
        assert.ok([200, 201].includes(r.status), r.text);
        const id = r.json().thread.access_id;
        assert.strictEqual((await t.get(`/api/v1/comments/threads/${id}`)).status, 404);
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
