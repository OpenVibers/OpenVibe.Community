'use strict';
// The move script and Community's Media client (server/media/objects.js,
// scripts/move-screenshots-private.js): a 404 from the tenant delete is a legacy object to retire,
// never "already gone"; --apply pages every paste with an id cursor; --retire-ids retires lost-record
// objects; a dry run only reports moves, retires and refusals. Fake Media only: no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { ids } = require('openvibe-contracts');
const { createMediaObjects } = require('../server/media/objects');
const { moveScreenshotsPrivate, readRetireIds } = require('../scripts/move-screenshots-private');
const { testDb } = require('./helpers/db');

(async () => {
    // ── Community's Media client: 404 and 409 are errors, and the retire route is its own call ──
    {
        const seen = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
                if (req.url === '/oauth/token') return json(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 300 });
                seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
                if (req.method === 'DELETE') {
                    if (req.url.endsWith('/med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3')) return json(404, { code: 'media.object.not_found' });
                    if (req.url.endsWith('/med_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4')) return json(409, { code: 'media.object.held' });
                    return json(200, { id: 'ok', lifecycle_status: 'deleted' });
                }
                if (req.method === 'POST' && req.url === '/internal/community/legacy-paste-screenshots/med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3/retire') {
                    return json(200, { id: 'med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', lifecycle_status: 'deleted', changed: true, retention_until: '2026-12-06T00:00:00.000Z' });
                }
                return json(404, { error: 'not found' });
            });
        });
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            const mo = createMediaObjects({ config: { oauth: { clientId: 'community', clientSecret: 'x'.repeat(40) }, networkInternalUrl: base, mediaInternalUrl: base, mediaUrl: 'https://openvibe.media' } });
            assert.deepStrictEqual(await mo.deleteObject('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2C5'), { deleted: true });
            await assert.rejects(() => mo.deleteObject('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3'), (e) => e.status === 404, '404 is not gone');
            await assert.rejects(() => mo.deleteObject('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4'), (e) => e.status === 409, '409 stays a refusal');
            const retired = await mo.retireLegacyPaste('med_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3');
            assert.deepStrictEqual([retired.retired, retired.changed], [true, true]);
            const call = seen.find((s) => s.url.includes('/retire'));
            assert.ok(call && call.authorization && call.authorization.startsWith('Bearer '), 'the retire call carries the service token');
        } finally {
            await new Promise((r) => server.close(r));
        }
        console.log('✅ the Media client: success deletes, 404/409 throw, retire uses the internal route');
    }

    // ── The script: dry run, cursor paging, 404→retire, 409 keeps the reference, --retire-ids ──
    const db = await testDb();
    try {
        const mediaUrl = 'https://openvibe.media';
        const add = async (slug, oldId, meta = '{}') => {
            await db.prepare(`INSERT INTO pastes (slug, owner_subject, type, title, content, visibility, screenshot_url, media_ref, metadata)
                VALUES (?, ?, 'screenshot', ?, '', 'public', ?, ?, ?)`)
                .run(slug, null, slug, oldId ? `${mediaUrl}/o/${oldId}` : `${mediaUrl}/f/legacy-community-file.png`, oldId || 'legacy:community:file:shot', meta);
        };
        const row = async (slug) => await db.prepare('SELECT screenshot_url, media_ref, metadata FROM pastes WHERE slug = ?').get(slug);

        const old = Object.fromEntries(['ok1', 'legacy', 'held', 'ok2', 'ok3'].map((k) => [k, ids.newId('media')]));
        await add('row-ok-1', old.ok1);
        await add('row-legacy', old.legacy, JSON.stringify({ media_visibility: 'private', previous_media_ref: old.legacy }));   // already moved, pending delete
        await add('row-held', old.held, JSON.stringify({ media_visibility: 'private', previous_media_ref: old.held }));
        await add('row-ok-2', old.ok2);
        await add('row-ok-3', old.ok3);
        await add('row-no-media-id', null);                    // legacy community file: no v2 id to remove

        const fake = {
            uploads: 0, deleted: [], retired: [], mode: new Map(), retiredOnce: new Set(),
            async uploadImage() {
                this.uploads++;
                const id = ids.newId('media');
                return { id, url: `${mediaUrl}/o/${id}`, size_bytes: 3, mime: 'image/png' };
            },
            async deleteObject(id) {
                const mode = this.mode.get(id) || 'ok';
                if (mode === '404') { const e = new Error(`Media DELETE 404: not in tenant`); e.status = 404; throw e; }
                if (mode === '409') { const e = new Error(`Media DELETE 409: held`); e.status = 409; e.code = 'media.object.held'; throw e; }
                if (mode === 'legacy') { const e = new Error(`Media DELETE 409: legacy managed`); e.status = 409; e.code = 'media.object.legacy_managed'; throw e; }
                this.deleted.push(id);
            },
            async retireLegacyPaste(id) {
                if (this.mode.get(id) === 'retire409') { const e = new Error(`Media POST retire 409: not a paste screenshot`); e.status = 409; throw e; }
                this.retired.push(id);
                const changed = !this.retiredOnce.has(id);
                this.retiredOnce.add(id);
                return { retired: true, changed };
            },
        };
        // A legacy Live object answers 404 to Community's delete; the held one is refused; an old
        // Community v1 file answers 409 legacy_managed and waits for the reference check.
        fake.mode.set(old.legacy, '404');
        fake.mode.set(old.held, '409');
        const fetchImpl = async () => new Response(Buffer.from('OLD'), { status: 200, headers: { 'content-type': 'image/png' } });
        const logs = [];
        const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) };

        // Dry run: one batch, plan only — no upload, no delete, no metadata write.
        let out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 10, apply: false });
        assert.deepStrictEqual([out.seen, out.moved], [6, 0], JSON.stringify(out));
        assert.deepStrictEqual(out.plan, { move: 4, retire: 5, refuse: 1 }, JSON.stringify(out.plan));
        assert.strictEqual(fake.uploads, 0, 'a dry run uploads nothing');
        assert.strictEqual(fake.retired.length, 0, 'a dry run retires nothing');
        assert.ok(logs.some((l) => l.startsWith('would move ')) && logs.some((l) => l.startsWith('would delete/retire ')), 'the dry run says what it would do');
        assert.strictEqual(JSON.parse((await row('row-ok-1')).metadata).media_visibility, undefined, 'nothing was written');
        console.log('✅ the dry run plans moves, retires and refusals without changing anything');

        // Apply with limit 2: 6 rows over more than one batch, the 404 retired, the 409 kept for a retry.
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 2, apply: true });
        assert.deepStrictEqual([out.seen, out.moved, out.failed], [6, 4, 0], JSON.stringify(out));
        assert.deepStrictEqual([out.deleted, out.retired, out.deleteFailed, out.refused, out.notDeletable], [3, 1, 1, 1, 1], JSON.stringify(out));
        assert.ok(out.batches > 2, `paged over more than one batch (${out.batches})`);
        assert.strictEqual(fake.uploads, 4, 'only the four not-yet-private rows were re-hosted');
        assert.strictEqual(fake.retired.includes(old.legacy), true, 'the 404 went to the retire route');
        assert.strictEqual(fake.deleted.includes(old.legacy), false);
        const legacyRow = await row('row-legacy');
        assert.strictEqual(JSON.parse(legacyRow.metadata).previous_media_ref, undefined, 'a retired object clears the record');
        const heldRow = await row('row-held');
        assert.strictEqual(JSON.parse(heldRow.metadata).previous_media_ref, old.held, 'a refusal keeps the reference');
        for (const slug of ['row-ok-1', 'row-legacy', 'row-held', 'row-ok-2', 'row-ok-3', 'row-no-media-id']) {
            assert.strictEqual(JSON.parse((await row(slug)).metadata).media_visibility, 'private', `${slug} is private`);
        }
        console.log('✅ apply pages every row: 404→retire, 409 keeps previous_media_ref, no-id row refused');

        // The next run retries the kept reference, now that Media accepts the delete.
        fake.mode.set(old.held, 'ok');
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 2, apply: true });
        assert.deepStrictEqual([out.deleted, out.skipped, out.deleteFailed], [1, 5, 0], JSON.stringify(out));
        assert.strictEqual(JSON.parse((await row('row-held')).metadata).previous_media_ref, undefined, 'the retry cleared it');
        console.log('✅ a later run retries the kept reference and clears it');

        // ── A legacy Community v1 file is retired only when nothing else references it ──
        const commFile = ids.newId('media');
        const refPaste = ids.newId('media');
        const refPost = ids.newId('media');
        const refAttachment = ids.newId('media');
        const refSubmission = ids.newId('media');
        for (const [slug, object] of [
            ['row-community-file', commFile], ['row-ref-paste', refPaste], ['row-ref-post', refPost],
            ['row-ref-attachment', refAttachment], ['row-ref-submission', refSubmission],
        ]) {
            await add(slug, object, JSON.stringify({ media_visibility: 'private', previous_media_ref: object }));
            fake.mode.set(object, 'legacy');
        }
        await db.prepare(`INSERT INTO pastes (slug, type, title, content, visibility, media_ref)
            VALUES ('ref-holder', 'paste', 'holder', '', 'public', ?)`).run(refPaste);
        const space = (await db.prepare("INSERT INTO spaces (slug, name) VALUES ('ref-space', 'Reference space') RETURNING id").run()).lastInsertRowid;
        const thread = (await db.prepare("INSERT INTO threads (space_id, slug, title) VALUES (?, 'ref-thread', 'Reference thread') RETURNING id").run(space)).lastInsertRowid;
        await db.prepare('INSERT INTO posts (thread_id, body_markdown) VALUES (?, ?)').run(thread, `![old](${mediaUrl}/o/${refPost})`);
        const owner = ids.newId('user');
        await db.prepare(`INSERT INTO attachments (media_id, owner_subject, filename, mime, size_bytes, url)
            VALUES (?, ?, 'old.png', 'image/png', 3, ?)`).run(refAttachment, owner, `${mediaUrl}/o/${refAttachment}`);
        await db.prepare(`INSERT INTO submissions (slug, kind, title, body, media_ref, author_subject)
            VALUES ('ref-submission', 'art', 'Reference art', '', ?, ?)`).run(refSubmission, owner);

        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 100, apply: true });
        assert.deepStrictEqual([out.retired, out.referenced, out.deleteFailed, out.refused], [1, 4, 4, 0], JSON.stringify(out));
        assert.ok(fake.retired.includes(commFile), 'the unreferenced legacy community file was retired');
        for (const id of [refPaste, refPost, refAttachment, refSubmission]) assert.strictEqual(fake.retired.includes(id), false, `${id} stays`);
        assert.strictEqual(JSON.parse((await row('row-community-file')).metadata).previous_media_ref, undefined, 'the retired file clears its record');
        const expected = { 'row-ref-paste': refPaste, 'row-ref-post': refPost, 'row-ref-attachment': refAttachment, 'row-ref-submission': refSubmission };
        for (const [slug, id] of Object.entries(expected)) {
            assert.strictEqual(JSON.parse((await row(slug)).metadata).previous_media_ref, id, `${slug} keeps its reference`);
        }
        for (const where of ['pastes (1)', 'posts (1)', 'attachments (1)', 'submissions (1)']) {
            assert.ok(logs.some((l) => l.includes(`still referenced by ${where}`)), `the summary says ${where}`);
        }
        console.log('✅ a legacy Community file is retired only when no paste, post, attachment or submission references it');

        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, apply: true, retireIds: [refPaste] });
        assert.deepStrictEqual([out.referenced, out.refused, out.retired, out.retireFailed], [1, 1, 0, 0], JSON.stringify(out));
        console.log('✅ --retire-ids also leaves a referenced object alone');

        // --retire-ids: only those ids, no paste scan, dry run first; a repeat is Media's no-op.
        const lost1 = ids.newId('media');
        const lost2 = ids.newId('media');
        const file = path.join(os.tmpdir(), `ov-retire-ids-${process.pid}.txt`);
        fs.writeFileSync(file, `# the 2026-11-06 pilot\n${lost1}\n${lost2}\n-wgXuYn0 old ${lost1} new ${ids.newId('media')}\n# comment\n${lost1}\n`);
        assert.deepStrictEqual(readRetireIds(file), [lost1, lost2], 'one id per line; prose and repeats are ignored');

        fake.retired.length = 0;
        const uploadsBefore = fake.uploads;
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 2, apply: false, retireIds: [lost1, lost2] });
        assert.deepStrictEqual([out.seen, out.plan.retire, fake.retired.length, fake.uploads], [2, 2, 0, uploadsBefore], JSON.stringify(out));
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, limit: 2, apply: true, retireIds: [lost1, lost2] });
        assert.deepStrictEqual([out.retired, out.retireFailed, out.refused, out.moved], [2, 0, 0, 0], JSON.stringify(out));
        assert.deepStrictEqual(fake.retired, [lost1, lost2], 'no paste rows were scanned or moved');
        assert.strictEqual(fake.uploads, uploadsBefore, 'retire-ids never uploads');
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, apply: true, retireIds: [lost1] });
        assert.deepStrictEqual([out.retired, out.alreadyRetired, out.retireFailed], [1, 1, 0], JSON.stringify(out));
        out = await moveScreenshotsPrivate({ db, mediaObjects: fake, fetchImpl, log, apply: true, retireIds: ['not-an-id'] });
        assert.deepStrictEqual([out.refused, out.retired], [1, 0], JSON.stringify(out));
        fs.unlinkSync(file);
        console.log('✅ --retire-ids retires only the named ids, dry-runs, and treats a repeat as a no-op');
    } finally {
        await db.close();
    }
    console.log('move screenshots private: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
