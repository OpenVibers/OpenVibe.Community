'use strict';
/**
 * Community's threads and pastes in OpenVibe.Search (WS-O task 10): a public thread and a public paste
 * each go through the outbox as community.index_document.upserted (valid against the contract), again only
 * when they changed, with the revision up by one; a thread in a staff space or made members-only, and a
 * paste made unlisted, deleted or burning after reading, get one tombstone (or nothing, if never sent);
 * an NSFW paste and a crosspost are noindex; the scan finds a paste changed since the last scan; the
 * hourly refresh removes a sent paste that no longer exists.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const events = require('../server/events');
const pastes = require('../server/pastes/store');
const forum = require('../server/forum/store');
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

    await db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('general', 'General', 'public'), ('staff', 'Staff', 'staff') ON CONFLICT DO NOTHING").run();
    const general = (await db.prepare("SELECT id FROM spaces WHERE slug = 'general'").get()).id;
    const staff = (await db.prepare("SELECT id FROM spaces WHERE slug = 'staff'").get()).id;

    await check('a public thread: its title, opening post and replies; unchanged means nothing sent', async () => {
        const { thread } = await forum.createThread(db, { space_id: general, title: 'Hello there', author_subject: USR, body_markdown: '**First** post with a [link](https://example.com)' });
        await forum.addPost(db, { thread_id: thread.id, author_subject: USR, body_markdown: 'a reply body' });
        assert.strictEqual(await docs.publishThread(thread.id), 'sent');
        const ev = (await index())[0]; ok(ev);
        assert.deepStrictEqual(ev.subject, { type: 'thread', id: String(thread.id), revision: 1 });
        assert.strictEqual(ev.visibility, 'internal'); assert.strictEqual(ev.priority, 'low');
        assert.strictEqual(ev.payload.canonical_url, `${base}/s/general/t/${thread.slug}`);
        assert.strictEqual(ev.payload.summary, 'First post with a link');
        assert.ok(ev.payload.body.includes('a reply body'));
        assert.strictEqual(ev.payload.facets.space, 'general'); assert.strictEqual(ev.payload.facets.replies, 1);
        assert.strictEqual(await docs.publishThread(thread.id), 'unchanged');
    });

    await check('a staff thread is never sent; members-only gets one tombstone', async () => {
        const { thread: hidden } = await forum.createThread(db, { space_id: staff, title: 'Staff only', author_subject: USR, body_markdown: 'hidden' });
        assert.strictEqual(await docs.publishThread(hidden.id), 'unchanged');
        const t = await db.prepare("SELECT id FROM threads WHERE title = 'Hello there'").get();
        await forum.setThreadMembersOnly(db, t.id, USR);
        assert.strictEqual(await docs.publishThread(t.id), 'tombstone');
        assert.strictEqual(await docs.publishThread(t.id), 'unchanged', 'a tombstone is sent once');
        const ev = (await index()).at(-1); ok(ev);
        assert.deepStrictEqual(ev.payload, { type: 'thread', id: String(t.id), revision: 2 });
        assert.ok(!(await index()).some((e) => JSON.stringify(e).includes('hidden')), 'nothing of a staff thread');
    });

    await check('a crosspost is noindex', async () => {
        const { thread } = await forum.createThread(db, { space_id: general, title: 'Also here', author_subject: USR, body_markdown: 'see the original', crosspost_of: 1 });
        await docs.publishThread(thread.id);
        const ev = (await index()).at(-1); ok(ev);
        assert.deepStrictEqual(ev.payload.indexability, { decision: 'noindex', reasons: ['crosspost'] });
    });

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
