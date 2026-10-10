'use strict';
/**
 * Community's resource index for OpenVibe.Services (server/registry/resource-index.js, community.resource.read): a
 * person's pastes and the spaces they created as common.resource-summary@1, pastes then spaces by slug on an opaque
 * cursor; owner keeps one subject's own, project is always empty, a deleted paste never appears, nothing but the
 * summary leaves (no content); only a service token holding the capability reads it, and no name resolves by OVRN.
 */
const assert = require('assert');
const { validate, ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const forumStore = require('../server/forum/store');

(async () => {
    const t = await boot();
    const db = t.app.locals.db || t.db;
    const alice = ids.newId('user');
    const bob = ids.newId('user');
    const agent = ids.newId('agent');
    const paste = async (slug, owner, extra = {}) => db.prepare(`INSERT INTO pastes (slug, owner_subject, title, content, visibility, deleted_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, owner, extra.title || `Paste ${slug}`, 'SECRET-CONTENT-never-in-the-index', extra.visibility || 'public',
        extra.deleted ? '2026-10-10 12:00:00' : null, '2026-10-01 10:00:00', '2026-10-02 11:30:00');
    await paste('ri-a1', alice, { title: 'Alice one' });
    await paste('ri-a2', alice, { visibility: 'private' });
    await paste('ri-b1', bob);
    await paste('ri-ai', null, { title: 'From a stream' });
    await paste('ri-gone', alice, { deleted: true });
    await paste('ri-ag', agent);
    await forumStore.createSpace(db, { slug: 'ri-space-alice', name: 'Alice\'s space', created_by: alice, visibility: 'members' });

    const reader = t.network.signService({ sub: 'svc:services', cap: ['community.resource.read'] });
    const list = (q = '', token = reader) => t.get(`/api/v1/resources${q}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const ours = (rows) => rows.filter((r) => r.id.startsWith('ri-'));

    await check('pastes then spaces, as resource summaries that validate, with nothing but the summary', async () => {
        const r = await list('?limit=1000');
        assert.strictEqual(r.status, 200, r.text);
        const body = r.json();
        assert.ok(validate('common.resource-list-result@1', body).valid, JSON.stringify(validate('common.resource-list-result@1', body).errors));
        const mine = ours(body.resources);
        assert.deepStrictEqual(mine.map((x) => x.id), ['ri-a1', 'ri-a2', 'ri-ag', 'ri-ai', 'ri-b1', 'ri-space-alice'], 'by kind, then slug; the deleted paste is left out');
        const a1 = mine[0];
        assert.deepStrictEqual(a1, { id: 'ri-a1', kind: 'community.paste', service: 'community', name: 'Alice one', state: 'public', created_at: '2026-10-01T10:00:00.000Z', updated_at: '2026-10-02T11:30:00.000Z', owner: { type: 'user', id: alice } });
        assert.strictEqual(mine.find((x) => x.id === 'ri-a2').state, 'private');
        assert.deepStrictEqual(mine.find((x) => x.id === 'ri-ag').owner, { type: 'agent', id: agent });
        assert.strictEqual('owner' in mine.find((x) => x.id === 'ri-ai'), false, 'a paste no person owns has no owner');
        const sp = mine.find((x) => x.id === 'ri-space-alice');
        assert.deepStrictEqual([sp.kind, sp.name, sp.state, sp.owner.id], ['community.space', 'Alice\'s space', 'members', alice]);
        assert.ok(!r.text.includes('SECRET-CONTENT'), 'no paste content leaves the index');
        assert.ok(body.resources.every((x) => !('ovrn' in x) && !('project_id' in x)), 'person-owned: no project, no OVRN');
    });

    await check('owner keeps one subject\'s own, across both kinds; kind and project narrow it', async () => {
        assert.deepStrictEqual(ours((await list(`?owner=${alice}&limit=1000`)).json().resources).map((x) => x.id), ['ri-a1', 'ri-a2', 'ri-space-alice']);
        assert.deepStrictEqual(ours((await list(`?owner=${bob}`)).json().resources).map((x) => x.id), ['ri-b1']);
        assert.deepStrictEqual(ours((await list(`?owner=${alice}&kind=community.space`)).json().resources).map((x) => x.id), ['ri-space-alice']);
        assert.deepStrictEqual((await list('?kind=bot.robot')).json().resources, [], 'a kind this index does not hold: nothing');
        assert.deepStrictEqual((await list(`?project=prj_${'0'.repeat(26)}`)).json(), { resources: [], next_cursor: null }, 'nothing here belongs to a project');
    });

    await check('the cursor walks every row exactly once, across the kinds', async () => {
        const seen = [];
        let cursor = null;
        for (let i = 0; i < 50; i++) {
            const body = (await list(`?owner=${alice}&limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json();
            seen.push(...body.resources.map((x) => x.id));
            if (!body.next_cursor) break;
            cursor = body.next_cursor;
        }
        assert.deepStrictEqual(seen, ['ri-a1', 'ri-a2', 'ri-space-alice']);
    });

    await check('a malformed filter is 400 resources.bad_query, never ignored', async () => {
        for (const q of ['?owner=svc:live', '?owner=usr_short', '?project=prj_x', '?limit=0', '?limit=1001', '?cursor=not-ours']) {
            const r = await list(q);
            assert.deepStrictEqual([r.status, r.json().code], [400, 'resources.bad_query'], q);
        }
    });

    await check('only a service token holding community.resource.read; no OVRN resolves', async () => {
        assert.strictEqual((await list('', null)).status, 401);
        const other = t.network.signService({ sub: 'svc:live', cap: ['community.paste.create'] });
        assert.strictEqual((await list('', other)).status, 403);
        const user = t.network.sign({ id: 7, subject_id: alice, username: 'alice', role: 'user' });
        assert.strictEqual((await list('', user)).status, 403, 'a person\'s token is not a service token');
        const r = await list(`/ovrn:community:prj_${'0'.repeat(26)}:paste/abc_${'0'.repeat(26)}`);
        assert.strictEqual(r.status, 404);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
