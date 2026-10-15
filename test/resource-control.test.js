'use strict';
/**
 * ADR-048 amendment 2026-10-15: OpenVibe.Services deletes a person's paste through Community's control API
 * (community.resource.control, common.owned-resource-control-request@1), by the owner's own deletion path.
 */
const assert = require('assert');
const { ids, resources } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const db = t.app.locals.db || t.db;
    const alice = ids.newId('user');
    const bob = ids.newId('user');
    const paste = async (slug, owner, visibility = 'public') => db.prepare(`INSERT INTO pastes (slug, owner_subject, title, content, visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(slug, owner, `Paste ${slug}`, 'the content', visibility, '2026-10-01 10:00:00', '2026-10-01 10:00:00');
    await paste('rc-mine', alice, 'private');
    await paste('rc-theirs', bob);
    const services = t.network.signService({ sub: 'svc:services', cap: ['community.resource.control'] });
    let n = 0;
    const send = (body, token = services) => t.get('/api/v1/resources/control', { method: 'POST', body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const req = (action, over = {}) => ({
        action, owned: { kind: 'community.paste', id: 'rc-mine' }, owner: { type: 'user', id: alice },
        on_behalf_of: { type: 'user', id: alice }, idempotency_key: `idem_paste_${++n}_${Date.now()}`, ...over,
    });
    const gone = async (slug) => !!(await db.prepare('SELECT deleted_at FROM pastes WHERE slug = ?').get(slug)).deleted_at;

    await check('a dry run applies nothing; delete takes the owner\'s deletion path once; a repeat answers the first result', async () => {
        let r = await send(req('delete', { dry_run: true }));
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.json().state, r.json().result.dry_run], ['done', true]);
        assert.strictEqual(await gone('rc-mine'), false);
        const first = req('delete');
        r = await send(first);
        const body = r.json();
        assert.ok(resources.checkControlResult(body).valid, JSON.stringify(body));
        assert.deepStrictEqual([body.state, body.result, body.resource], ['done', { deleted: true }, undefined]);
        assert.strictEqual(await gone('rc-mine'), true);
        assert.strictEqual((await db.prepare('SELECT content FROM pastes WHERE slug = ?').get('rc-mine')).content, null, 'its content is dropped, as the owner\'s delete does');
        assert.deepStrictEqual((await send(first)).json(), body, 'the same key answers the first result');
        const conflict = await send({ ...first, dry_run: true });
        assert.deepStrictEqual([conflict.status, conflict.json().code], [409, 'control.idempotency_conflict']);
        r = await send(req('delete'));
        assert.deepStrictEqual([r.json().state, r.json().problem.code], ['refused', 'resources.unknown_resource'], 'a paste already gone is unknown');
    });

    await check('only the owner Community holds; other actions and kinds are refused', async () => {
        let r = await send(req('delete', { owned: { kind: 'community.paste', id: 'rc-theirs' } }));
        assert.deepStrictEqual([r.json().state, r.json().problem.code], ['refused', 'resources.unknown_resource'], 'another person\'s paste is not confirmed to exist');
        assert.strictEqual(await gone('rc-theirs'), false);
        r = await send(req('archive', { owned: { kind: 'community.paste', id: 'rc-theirs' } }));
        assert.strictEqual(r.json().problem.code, 'control.unsupported_action');
        r = await send(req('delete', { owned: { kind: 'community.space', id: 'a-space' } }));
        assert.strictEqual(r.json().problem.code, 'resources.unknown_resource');
        r = await send(req('delete', { on_behalf_of: { type: 'user', id: bob } }));
        assert.deepStrictEqual([r.status, r.json().code], [400, 'control.bad_request'], 'a person acts only on what they own');
        r = await send({ action: 'delete', resource: 'ovrn:community:prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C:paste/pst_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', project_id: 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C', idempotency_key: 'idem_project_1' });
        assert.deepStrictEqual([r.status, r.json().code], [400, 'control.bad_request'], 'Community holds no project resources');
    });

    await check('first-party only, with community.resource.control', async () => {
        let r = await send(req('delete', { owned: { kind: 'community.paste', id: 'rc-theirs' } }), t.network.signService({ sub: 'svc:services', cap: ['community.resource.read'] }));
        assert.strictEqual(r.status, 403);
        r = await send(req('delete', { owned: { kind: 'community.paste', id: 'rc-theirs' } }), null);
        assert.strictEqual(r.status, 401);
        assert.strictEqual(await gone('rc-theirs'), false);
    });

    await done(t);
})().catch((e) => { console.error(e); process.exit(1); });
