'use strict';
/**
 * Community's events: every write queues its community.* event in the same transaction (a failed write
 * queues nothing), payloads validate against openvibe-contracts and never carry content, and items
 * that are not public travel as internal events without a URL.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const events = require('../server/events');
const pastes = require('../server/pastes/store');
const comments = require('../server/comments/store');

(async () => {
    const db = await testDb();
    // An outbox publisher that never publishes during the test: the rows stay in the outbox for inspection.
    events.init(db, { eventsUrl: 'http://127.0.0.1:9', clientSecret: 'test-secret', intervalMs: 3_600_000, fetchImpl: async () => { throw new Error('offline'); } });
    const queued = async () => (await db.prepare("SELECT envelope FROM event_outbox ORDER BY id").all()).map((r) => (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) : r.envelope) : r.envelope));
    const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const ok = (env) => { const r = contracts.validate(`${env.event_type}@1`, env.payload); assert.ok(r.valid, `${env.event_type}: ${JSON.stringify(r.errors)}`); };

    let n = 0;
    async function check(name, fn) { await fn(); n++; console.log(`  ✓ ${name}`); }

    await check('a paste create, edit, visibility change and delete each queue one event, never the content', async () => {
        const p = await pastes.insertPaste(db, { slug: 'amber-fox-42', owner_subject: USR, origin: 'user', type: 'paste', title: 'secret title', content: 'secret body', language: 'text', visibility: 'public' });
        await pastes.updatePaste(db, p.id, { content: 'edited body' }, USR);
        await pastes.setVisibility(db, p.id, 'unlisted');
        await pastes.softDelete(db, p.id);
        const evs = await queued();
        assert.deepStrictEqual(evs.map((e) => e.event_type), ['community.paste.created', 'community.paste.updated', 'community.paste.updated', 'community.paste.deleted']);
        evs.forEach(ok);
        assert.ok(!JSON.stringify(evs).includes('secret'), 'no title or content in any event');
        assert.strictEqual(evs[0].visibility, 'public');
        assert.strictEqual(evs[0].payload.url, 'https://openvibe.community/p/amber-fox-42'.replace('https://openvibe.community', require('../server/config').baseUrl));
        assert.deepStrictEqual(evs[1].payload.changed, ['content']);
        assert.strictEqual(evs[2].visibility, 'internal', 'an unlisted paste is not a public event');
        assert.strictEqual(evs[2].payload.url, null);
        assert.deepStrictEqual(evs[0].actor, { type: 'user', id: USR });
    });

    await check('a write that fails queues nothing (the event is in its transaction)', async () => {
        const before = (await queued()).length;
        await assert.rejects(async () => await pastes.insertPaste(db, { slug: 'amber-fox-42', owner_subject: USR, type: 'paste', content: 'dup', visibility: 'public' }), /duplicate key/);
        assert.strictEqual((await queued()).length, before);
    });

    await check('a comment on a Live VOD queues community.comment.created with its ref', async () => {
        const before = (await queued()).length;
        const t = (await comments.resolveThread(db, { service: 'live', type: 'vod', id: '906' })).thread;
        await comments.insertComment(db, { thread_id: t.id, author_subject: USR, message: 'nice stream' });
        const evs = (await queued()).slice(before);
        assert.deepStrictEqual(evs.map((e) => e.event_type), ['community.comment.created']);
        evs.forEach(ok);
        assert.deepStrictEqual(evs[0].payload.ref, { service: 'live', type: 'vod', id: '906' });
        assert.ok(!JSON.stringify(evs).includes('nice stream'));
    });

    await check('staff actions on someone else\'s content go to the moderation audit log (ADR-022); an owner\'s own do not', async () => {
        const { createPasteService } = require('../server/pastes/service');
        const svc = createPasteService({ db });
        const STAFF = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
        await pastes.insertPaste(db, { slug: 'mod-target-1', owner_subject: USR, origin: 'user', type: 'paste', title: 't', content: 'secret words', language: 'text', visibility: 'public' });
        await pastes.insertPaste(db, { slug: 'own-paste-1', owner_subject: USR, origin: 'user', type: 'paste', title: 't', content: 'x', language: 'text', visibility: 'public' });
        const before = (await queued()).length;
        await svc.remove({ kind: 'user', subject: STAFF, staff: true }, 'mod-target-1');
        await svc.remove({ kind: 'user', subject: USR }, 'own-paste-1');
        const evs = (await queued()).slice(before);
        const mod = evs.filter((e) => e.event_type === 'community.moderation.action');
        assert.strictEqual(mod.length, 1, 'only the staff delete is audited');
        ok(mod[0]);
        assert.deepStrictEqual(mod[0].payload.target, { type: 'paste', id: 'mod-target-1', owner_subject: USR });
        assert.strictEqual(mod[0].payload.actor_subject, STAFF);
        assert.deepStrictEqual(mod[0].actor, { type: 'user', id: STAFF });
        assert.ok(!JSON.stringify(mod).includes('secret words'), 'never the content');
        await pastes.insertPaste(db, { slug: 'bulk-target-1', owner_subject: USR, origin: 'user', type: 'paste', title: 't', content: 'x', language: 'text', visibility: 'public' });
        const bulk = await svc.bulk({ slugs: ['bulk-target-1', 'nope'], action: 'private' }, { kind: 'user', subject: STAFF, staff: true });
        assert.deepStrictEqual([bulk.done, bulk.skipped], [1, 1]);
        const last = (await queued()).slice(-1)[0];
        assert.strictEqual(last.event_type, 'community.moderation.action');
        assert.deepStrictEqual(last.payload.details, { bulk_action: 'private', done: bulk.done, skipped: bulk.skipped });
        ok(last);
    });

    events._reset();
    console.log(`community events: ${n} checks passed`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
