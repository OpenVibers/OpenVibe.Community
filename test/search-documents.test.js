'use strict';
/** Paste Search documents and tombstones through the Events outbox. */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const events = require('../server/events');
const pastes = require('../server/pastes/store');
const { createSearchDocuments } = require('../server/search/documents');

(async () => {
    const db = await testDb();
    events.init(db, { eventsUrl: 'http://127.0.0.1:9', clientSecret: 'test-secret', intervalMs: 3_600_000, fetchImpl: async () => { throw new Error('offline'); } });
    const index = async () => (await db.prepare("SELECT envelope FROM event_outbox ORDER BY id").all()).map((r) => (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope) : r.envelope) : r.envelope)).filter((e) => /^community\.index_document\./.test(e.event_type));
    const ok = (env) => { const r = contracts.validate(`${env.event_type}@1`, env.payload); assert.ok(r.valid, `${env.event_type}: ${JSON.stringify(r.errors)}`); };
    const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const docs = createSearchDocuments({ db });
    const base = require('../server/config').baseUrl;

    let n = 0;
    async function check(name, fn) { await fn(); n++; console.log(`  ✓ ${name}`); }

    await check('pastes: public sent with its content, NSFW noindex, burn-after-read never, unlisted and deleted get a tombstone', async () => {
        const p = await pastes.insertPaste(db, { slug: 'amber-fox-42', owner_subject: USR, origin: 'user', type: 'paste', title: 'Quick sort', content: 'function sort(a) { return a; }', language: 'javascript', visibility: 'public' });
        const nsfw = await pastes.insertPaste(db, { slug: 'red-owl-7', owner_subject: USR, origin: 'ai', type: 'paste', title: 'x', content: 'y', language: 'text', visibility: 'public', is_nsfw: 1 });
        const burn = await pastes.insertPaste(db, { slug: 'blue-cat-9', owner_subject: USR, type: 'paste', title: 'secret', content: 'burns', visibility: 'public', burn_after_read: 1 });
        const row = async (id) => await db.prepare('SELECT * FROM pastes WHERE id = ?').get(id);
        assert.strictEqual(await docs.publishPaste(await row(p.id)), 'sent');
        assert.strictEqual(await docs.publishPaste(await row(nsfw.id)), 'sent');
        assert.strictEqual(await docs.publishPaste(await row(burn.id)), 'unchanged');
        const [a, b] = (await index()).slice(-2); ok(a); ok(b);
        assert.strictEqual(a.payload.id, 'amber-fox-42'); assert.strictEqual(a.payload.canonical_url, `${base}/p/amber-fox-42`);
        assert.ok(a.payload.body.includes('function sort')); assert.strictEqual(a.payload.facets.syntax, 'javascript');
        assert.ok(!('language' in a.payload), 'a paste\'s syntax is not a human language');
        assert.deepStrictEqual(b.payload.indexability, { decision: 'noindex', reasons: ['sensitive'] });
        assert.strictEqual(b.payload.authorship, 'ai_generated');
        await pastes.setVisibility(db, p.id, 'unlisted');
        assert.strictEqual(await docs.publishPaste(await row(p.id)), 'tombstone');
        ok((await index()).at(-1)); assert.deepStrictEqual((await index()).at(-1).payload, { type: 'paste', id: 'amber-fox-42', revision: 2 });
    });

    await check('the scan finds a paste changed since the last scan; the refresh removes one that is gone', async () => {
        const now = Date.now();
        await docs.scan({ now });
        const before = (await index()).length;
        const p = await pastes.insertPaste(db, { slug: 'green-elk-3', owner_subject: USR, type: 'paste', title: 'Later', content: 'later body', visibility: 'public' });
        await db.prepare("UPDATE pastes SET created_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(p.id);
        await docs.scan({ now: now + 60_000 });
        assert.ok((await index()).slice(before).some((e) => e.payload.id === 'green-elk-3' && e.event_type === 'community.index_document.upserted'));
        await db.prepare('DELETE FROM pastes WHERE id = ?').run(p.id);
        await docs.refresh();
        const last = (await index()).at(-1); ok(last);
        assert.deepStrictEqual(last.payload, { type: 'paste', id: 'green-elk-3', revision: 2 });
    });

    await check('a slug starting with a dash is indexed as paste_<id> (a document id starts with a letter or digit)', async () => {
        const p = await pastes.insertPaste(db, { slug: '-wgXuYn0', owner_subject: USR, type: 'paste', title: 'Dash', content: 'dash body', visibility: 'public' });
        await db.prepare("INSERT INTO search_doc_pushes (type, id, hash, revision) VALUES ('paste', '-wgXuYn0', 'x', 1)").run();
        assert.strictEqual(await docs.publishPaste(await db.prepare('SELECT * FROM pastes WHERE id = ?').get(p.id)), 'sent');
        const ev = (await index()).at(-1); ok(ev);
        assert.strictEqual(ev.payload.id, `paste_${p.id}`); assert.strictEqual(ev.payload.canonical_url, `${base}/p/-wgXuYn0`);
        const r = contracts.validate('search.index-document@1', ev.payload); assert.ok(r.valid, JSON.stringify(r.errors));
        const before = (await index()).length;
        await docs.refresh();
        assert.ok(!await db.prepare("SELECT 1 FROM search_doc_pushes WHERE id = '-wgXuYn0'").get(), 'the unacceptable id is forgotten');
        assert.ok(!(await index()).slice(before).some((e) => e.payload.id === '-wgXuYn0'), 'and no tombstone is sent for it');
    });

    events._reset();
    console.log(`search documents: ${n} checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
