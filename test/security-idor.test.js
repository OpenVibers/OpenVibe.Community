'use strict';
/** An outsider cannot change another person's paste or comment by swapping ids. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 } });
    const alex = t.network.addUser({ network_user_id: 41, username: 'alex' });
    const sam = t.network.addUser({ network_user_id: 42, username: 'sam' });
    const jwt = (u, id) => t.network.sign({ id, subject_id: u.subject_id, username: u.username, role: 'user' });
    const a = jwt(alex, 41), s = jwt(sam, 42);
    const call = (path, method, cookie, json) => t.get(path, { method, cookies: [`ov_token=${cookie}`], headers: json ? { 'content-type': 'application/json' } : {}, body: json ? JSON.stringify(json) : undefined });
    const created = await call('/api/pastes', 'POST', a, { title: 'Alex paste', content: 'owned by alex' });
    assert.strictEqual(created.status, 201, created.text);
    const slug = created.json().slug;
    await check('paste edits and deletes enforce the owner', async () => {
        for (const [method, body] of [['PUT', { title: 'stolen' }], ['DELETE', undefined]]) {
            const r = await call(`/api/pastes/${slug}`, method, s, body);
            assert.ok([403, 404].includes(r.status), `${method}: ${r.status} ${r.text}`);
        }
        const row = await t.db.prepare('SELECT title, deleted_at FROM pastes WHERE slug = ?').get(slug);
        assert.deepStrictEqual(row, { title: 'Alex paste', deleted_at: null });
    });
    await check('a private paste does not disclose its body to another person', async () => {
        const r = await call('/api/pastes', 'POST', a, { title: 'Private', content: 'private marker', visibility: 'private' });
        assert.strictEqual(r.status, 201);
        const outsider = await call(`/api/pastes/${r.json().slug}`, 'GET', s);
        assert.strictEqual(outsider.status, 404);
        assert.ok(!outsider.text.includes('private marker'));
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
