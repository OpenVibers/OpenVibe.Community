'use strict';
/**
 * scripts/import-pastes.js + server/pastes/importer.js: bundle verification, owner mapping across
 * the id-space cutoff (ambiguous / unmapped → holds), AI pastes, fork and reply remapping, likes,
 * idempotent re-runs, newer bundles, dry runs, and the CLI's exit codes.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openDb } = require('../server/db');
const { importBundle, ImportError } = require('../server/pastes/importer');
const { createNetworkIdentity } = require('../server/identity/network');
const mockNetwork = require('./helpers/mock-network');
const { check, done } = require('./helpers/app');

const PRE = '2026-08-18 10:00:00';   // between the OpenVibe launch (2026-08-17T21:10:29Z) and the id-space fix (2026-08-20T03:00:26Z)
const MIGRATED = '2026-08-01 10:00:00';  // before the launch: rows migrated from HoboStreamer, Live ids
const POST = '2026-09-01 10:00:00';

function seal(bundle) {
    const { pastes, comments, likes } = bundle;
    return {
        format: 'openvibe.media.pastes-export', version: 1, app: 'live', generated_at: '2026-09-22T12:00:00Z',
        since_id: 0, max_id: Math.max(0, ...pastes.map((p) => p.id)),
        counts: { pastes: pastes.length, comments: comments.length, likes: likes.length },
        sha256: crypto.createHash('sha256').update(JSON.stringify({ pastes, comments, likes })).digest('hex'),
        pastes, comments, likes,
    };
}

const paste = (o) => ({
    id: 1, slug: 'amber-fox-11', user_id: null, type: 'paste', title: 'T', content: 'c', language: 'text', visibility: 'public',
    stream_id: null, screenshot_url: null, metadata: null, burn_after_read: 0, forked_from: null, pinned: 0, views: 0, unique_views: 0,
    copies: 0, likes: 0, is_nsfw: 0, ai_summary: null, ai_tags: null, ai_analyzed_at: null, created_at: POST, updated_at: POST, ...o,
});

(async () => {
    const net = await mockNetwork.start();
    // A: network 7 = live 107.  B: network 9 = live 109.  C: live 9 (so "9" is ambiguous before the cutoff).
    const A = net.addUser({ network_user_id: 7, username: 'alex' });
    const B = net.addUser({ network_user_id: 9, username: 'sam' });
    const C = net.addUser({ network_user_id: 30, username: 'cleo' });
    net.directory.legacy.live = { 107: A.subject_id, 109: B.subject_id, 9: C.subject_id };
    const config = { networkInternalUrl: net.url, networkUrl: net.url, oauth: { clientId: 'community', clientSecret: 'shh' } };

    const db = openDb(':memory:');
    const identity = createNetworkIdentity({ config, db });
    const run = (bundle, opts = {}) => importBundle(db, bundle, { resolveLegacy: identity.resolveLegacy, source: 'test', ...opts });
    const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    const bySlug = (slug) => db.prepare('SELECT * FROM pastes WHERE slug = ?').get(slug);
    const holds = () => db.prepare('SELECT source_type, source_id, reason FROM import_hold ORDER BY source_type, source_id, reason').all();

    const pastes = [
        paste({ id: 6, slug: 'fork-of-one-66', user_id: 107, title: 'Fork of One', forked_from: 1 }),          // fork listed before its original
        paste({ id: 1, slug: 'amber-fox-11', user_id: 107, title: 'One', content: 'hello', language: 'javascript', views: 50, unique_views: 40, copies: 3, likes: 2, visibility: 'public', is_nsfw: 1, ai_summary: 'greets', ai_tags: ['hi'], ai_analyzed_at: '2026-09-02 00:00:00', created_at: POST, updated_at: '2026-09-03 00:00:00' }),
        paste({ id: 2, slug: 'blue-lake-22', user_id: 7, created_at: PRE, updated_at: PRE, visibility: 'unlisted' }),   // pre-cutoff, only the network mapping exists → A
        paste({ id: 3, slug: 'cold-ridge-33', user_id: 9, created_at: PRE, updated_at: PRE }),                            // pre-cutoff, live 9 = C, network 9 = B → ambiguous
        paste({ id: 4, slug: 'dark-owl-44', user_id: 555 }),                                                               // post-cutoff, unmapped
        paste({ id: 5, slug: 'wild-moment-5555', user_id: 109, type: 'screenshot', content: '', screenshot_url: 'https://openvibe.media/p/wild-moment-5555/screenshot', metadata: { ai_moment: true, stream_id: 77 }, ai_summary: 'hype' }),
        paste({ id: 7, slug: 'epic-frame-7777', user_id: 109, type: 'screenshot', screenshot_url: 'https://openvibe.media/p/epic-frame-7777/screenshot', stream_id: 12, metadata: { original_name: 'ai-moment-vod31-340.jpg', mime_type: 'image/jpeg' } }),
        paste({ id: 8, slug: 'gold-gem-88', user_id: 777, created_at: PRE, updated_at: PRE, visibility: 'private' }),  // pre-cutoff, no mapping at all
        paste({ id: 9, slug: 'gray-dove-99', user_id: null, title: 'anon' }),
    ];
    const comments = [
        { id: 11, paste_id: 1, user_id: 107, parent_id: null, anon_name: null, message: 'nice', is_deleted: 0, created_at: POST, updated_at: POST },
        { id: 12, paste_id: 1, user_id: null, parent_id: 11, anon_name: 'Visitor', message: 'agreed', is_deleted: 0, created_at: POST, updated_at: POST },
        { id: 13, paste_id: 1, user_id: 555, parent_id: null, anon_name: null, message: 'who am i', is_deleted: 0, created_at: POST, updated_at: POST },
        { id: 14, paste_id: 99, user_id: 107, parent_id: null, anon_name: null, message: 'orphan', is_deleted: 0, created_at: POST, updated_at: POST },
    ];
    const likes = [
        { paste_id: 1, user_id: 107, created_at: POST },
        { paste_id: 1, user_id: 555, created_at: POST },
        { paste_id: 1, user_id: 9, created_at: PRE },
    ];
    const bundle = seal({ pastes, comments, likes });

    await check('refuses a bundle whose format, version, counts or sha256 do not check out', async () => {
        for (const [mutate, re] of [
            [(b) => { b.sha256 = '0'.repeat(64); }, /sha256 mismatch/],
            [(b) => { b.counts.pastes += 1; }, /count mismatch for pastes/],
            [(b) => { b.format = 'something-else'; }, /unexpected format/],
            [(b) => { b.version = 2; }, /unsupported version/],
            [(b) => { b.pastes[0].title = 'tampered'; }, /sha256 mismatch/],
        ]) {
            const b = JSON.parse(JSON.stringify(bundle));
            mutate(b);
            await assert.rejects(run(b), (err) => err instanceof ImportError && re.test(err.message));
        }
        assert.strictEqual(count('pastes'), 0);
    });

    await check('--dry-run reports everything and leaves the database untouched', async () => {
        const r = await run(bundle, { dryRun: true });
        assert.strictEqual(r.dry_run, true);
        assert.strictEqual(r.pastes.inserted, 9);
        for (const t of ['pastes', 'paste_comments', 'paste_likes', 'import_hold', 'legacy_id_map', 'migration_runs']) assert.strictEqual(count(t), 0, t);
    });

    let first;
    await check('import: counters, timestamps, visibility, NSFW and AI fields kept; owners mapped across the cutoff', async () => {
        first = await run(bundle);
        assert.deepStrictEqual(first.pastes, { bundle: 9, inserted: 9, updated: 0, unchanged: 0, held: 3, skipped: 0, ai: 2, forks_remapped: 1, forks_unresolved: 0 });
        const one = bySlug('amber-fox-11');
        assert.strictEqual(one.owner_subject, A.subject_id);
        assert.strictEqual(one.legacy_media_id, 1);
        assert.strictEqual(one.legacy_user_id, 107);
        assert.strictEqual(one.views, 50);
        assert.strictEqual(one.unique_views, 40);
        assert.strictEqual(one.copies, 3);
        assert.strictEqual(one.likes, 2);
        assert.strictEqual(one.is_nsfw, 1);
        assert.strictEqual(one.ai_tags, '["hi"]');
        assert.strictEqual(one.created_at, POST);
        assert.strictEqual(one.updated_at, '2026-09-03 00:00:00');
        assert.strictEqual(one.origin, 'user');
        assert.strictEqual(bySlug('blue-lake-22').owner_subject, A.subject_id, 'pre-cutoff network id');
        assert.strictEqual(bySlug('blue-lake-22').visibility, 'unlisted');
        assert.strictEqual(bySlug('cold-ridge-33').owner_subject, null, 'ambiguous');
        assert.strictEqual(bySlug('cold-ridge-33').legacy_user_id, 9);
        assert.strictEqual(bySlug('dark-owl-44').owner_subject, null, 'unmapped');
        assert.strictEqual(bySlug('gold-gem-88').owner_subject, null);
        assert.strictEqual(bySlug('gray-dove-99').owner_subject, null, 'anonymous is not a hold');
        assert.strictEqual(bySlug('fork-of-one-66').forked_from, one.id, 'forked_from remapped to the Community id');
    });

    await check('AI moment pastes: origin ai, no owner, stream in stream_ref, screenshot link kept, no hold', async () => {
        const ai = bySlug('wild-moment-5555');
        assert.strictEqual(ai.origin, 'ai');
        assert.strictEqual(ai.owner_subject, null);
        assert.strictEqual(ai.legacy_user_id, 109);
        assert.deepStrictEqual(JSON.parse(ai.stream_ref), { service: 'live', type: 'stream', id: '77' });
        assert.strictEqual(ai.screenshot_url, 'https://openvibe.media/p/wild-moment-5555/screenshot');
        assert.strictEqual(ai.media_ref, 'legacy:live:paste:5');
        const byName = bySlug('epic-frame-7777');
        assert.strictEqual(byName.origin, 'ai', 'recognised by the AI frame file name Media kept');
        assert.deepStrictEqual(JSON.parse(byName.stream_ref), { service: 'live', type: 'stream', id: '12' });
        assert.ok(!holds().some((h) => h.source_id === '5' || h.source_id === '7'));
    });

    await check('holds: ambiguous / unmapped owners, unmappable likes and orphan comments', async () => {
        assert.deepStrictEqual(holds(), [
            { source_type: 'comment', source_id: '13', reason: 'owner_unmapped' },
            { source_type: 'comment', source_id: '14', reason: 'paste_missing' },
            { source_type: 'like', source_id: '1:555', reason: 'owner_unmapped' },
            { source_type: 'like', source_id: '1:9', reason: 'ambiguous_owner' },
            { source_type: 'paste', source_id: '3', reason: 'ambiguous_owner' },
            { source_type: 'paste', source_id: '4', reason: 'owner_unmapped' },
            { source_type: 'paste', source_id: '8', reason: 'owner_unmapped' },
        ]);
        const detail = JSON.parse(db.prepare("SELECT detail FROM import_hold WHERE source_type = 'paste' AND source_id = '3'").get().detail);
        assert.strictEqual(detail.live_subject, C.subject_id);
        assert.strictEqual(detail.network_subject, B.subject_id);
        assert.deepStrictEqual(first.holds, { ambiguous_owner: 2, owner_unmapped: 4, paste_missing: 1 });
    });

    await check('comments and likes: authors mapped, reply parents remapped, only mappable likes imported', async () => {
        const cs = db.prepare('SELECT * FROM paste_comments ORDER BY legacy_media_id').all();
        assert.strictEqual(cs.length, 3);
        const [c11, c12, c13] = cs;
        assert.strictEqual(c11.author_subject, A.subject_id);
        assert.strictEqual(c12.anon_name, 'Visitor');
        assert.strictEqual(c12.parent_id, c11.id);
        assert.strictEqual(c13.author_subject, null);
        assert.deepStrictEqual(first.comments, { bundle: 4, inserted: 3, updated: 0, unchanged: 0, held: 1, skipped: 1 });
        const ls = db.prepare('SELECT subject_id FROM paste_likes').all();
        assert.deepStrictEqual(ls, [{ subject_id: A.subject_id }]);
        assert.deepStrictEqual(first.likes, { bundle: 3, inserted: 1, updated: 0, unchanged: 0, held: 2, skipped: 0 });
    });

    await check('mappings and the run are recorded', async () => {
        const m = (sys, type, id) => db.prepare('SELECT target_type, target_id FROM legacy_id_map WHERE source_system = ? AND source_type = ? AND source_id = ?').get(sys, type, id);
        assert.deepStrictEqual(m('media', 'paste', '1'), { target_type: 'paste', target_id: String(bySlug('amber-fox-11').id) });
        assert.deepStrictEqual(m('live', 'user', '107'), { target_type: 'subject', target_id: A.subject_id });
        assert.deepStrictEqual(m('network', 'user', '7'), { target_type: 'subject', target_id: A.subject_id });
        assert.ok(m('media', 'comment', '12'));
        const runs = db.prepare('SELECT * FROM migration_runs').all();
        assert.strictEqual(runs.length, 1);
        assert.strictEqual(JSON.parse(runs[0].report).pastes.inserted, 9);
        assert.ok(runs[0].finished_at);
    });

    await check('re-running the same bundle changes nothing', async () => {
        const before = { pastes: count('pastes'), comments: count('paste_comments'), likes: count('paste_likes'), holds: count('import_hold') };
        const again = await run(bundle);
        assert.deepStrictEqual([again.pastes.inserted, again.pastes.updated, again.pastes.unchanged], [0, 0, 9]);
        assert.deepStrictEqual([again.comments.inserted, again.comments.updated, again.comments.unchanged], [0, 0, 3]);
        assert.deepStrictEqual([again.likes.inserted, again.likes.unchanged, again.likes.held], [0, 1, 2]);
        assert.deepStrictEqual({ pastes: count('pastes'), comments: count('paste_comments'), likes: count('paste_likes'), holds: count('import_hold') }, before);
        assert.strictEqual(count('migration_runs'), 2);
    });

    await check('a newer bundle adds and updates; Community-side edits, counts and deletes are not undone; late mappings clear holds', async () => {
        // Community-side activity since the first import.
        db.prepare("UPDATE pastes SET views = 80 WHERE slug = 'amber-fox-11'").run();
        const store = require('../server/pastes/store');
        store.updatePaste(db, bySlug('blue-lake-22').id, { content: 'edited in Community' }, A.subject_id);
        store.softDelete(db, bySlug('gray-dove-99').id);
        // Someone registered live user 555 with the Network in the meantime.
        const D = net.addUser({ network_user_id: 40, username: 'dana' });
        net.directory.legacy.live[555] = D.subject_id;

        const newer = seal({
            pastes: pastes.map((p) => (p.id === 1 ? { ...p, title: 'One (renamed on Live)', views: 60, updated_at: '2026-09-10 00:00:00' }
                : p.id === 2 ? { ...p, content: 'changed on Live' } : p))
                .concat([paste({ id: 10, slug: 'new-wave-10', user_id: 109, created_at: '2026-09-20 00:00:00', updated_at: '2026-09-20 00:00:00' })]),
            comments: comments.concat([{ id: 15, paste_id: 10, user_id: 109, parent_id: null, anon_name: null, message: 'fresh', is_deleted: 0, created_at: POST, updated_at: POST }]),
            likes,
        });
        const r = await run(newer);
        assert.strictEqual(r.pastes.inserted, 1);
        assert.strictEqual(r.comments.inserted, 1);
        const one = bySlug('amber-fox-11');
        assert.strictEqual(one.title, 'One (renamed on Live)');
        assert.strictEqual(one.views, 80, 'counters never go down');
        assert.strictEqual(bySlug('blue-lake-22').content, 'edited in Community', 'local edits win');
        assert.ok(bySlug('gray-dove-99').deleted_at, 'deleted stays deleted');
        assert.strictEqual(bySlug('new-wave-10').owner_subject, B.subject_id);
        assert.strictEqual(bySlug('dark-owl-44').owner_subject, D.subject_id, 'late mapping fills the owner');
        assert.ok(!holds().some((h) => h.source_type === 'paste' && h.source_id === '4'), 'and clears its hold');
        assert.ok(!holds().some((h) => h.source_type === 'like' && h.source_id === '1:555'));
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM paste_likes').get().c, 2);
        assert.strictEqual(db.prepare("SELECT author_subject FROM paste_comments WHERE legacy_media_id = 13").get().author_subject, D.subject_id);
        assert.strictEqual(r.pastes.updated, 2, 'the renamed paste and the newly owned one');
    });

    await check('rows from before the OpenVibe launch map by Live id even when the number is also a Network id', async () => {
        const mdb = openDb(':memory:');
        const r = await importBundle(mdb, seal({ pastes: [paste({ id: 70, slug: 'old-hobo-70', user_id: 9, created_at: MIGRATED, updated_at: MIGRATED })], comments: [], likes: [] }), { resolveLegacy: identity.resolveLegacy, source: 'test' });
        const row = mdb.prepare('SELECT owner_subject FROM pastes WHERE slug = ?').get('old-hobo-70');
        assert.strictEqual(row.owner_subject, C.subject_id, 'live 9 = cleo, not network 9 = sam');
        assert.strictEqual(r.pastes.held, 0);
        const r2 = await importBundle(openDb(':memory:'), seal({ pastes: [paste({ id: 70, slug: 'old-hobo-70', user_id: 9, created_at: MIGRATED, updated_at: MIGRATED })], comments: [], likes: [] }), { resolveLegacy: identity.resolveLegacy, source: 'test', ambiguousFrom: null });
        assert.strictEqual(r2.pastes.held, 1, 'ambiguousFrom: null restores the whole-history window');
        mdb.close();
    });

    await check('CLI: exit 2 on a refused bundle, dry run prints the report and writes nothing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-import-'));
        const dbPath = path.join(dir, 'c.db');
        const good = path.join(dir, 'good.json');
        const bad = path.join(dir, 'bad.json');
        fs.writeFileSync(good, JSON.stringify(bundle));
        fs.writeFileSync(bad, JSON.stringify({ ...bundle, sha256: 'f'.repeat(64) }));
        const env = { ...process.env, COMMUNITY_DB_PATH: dbPath, OV_NETWORK_INTERNAL_URL: net.url, OV_NETWORK_URL: net.url, OV_OAUTH_CLIENT_ID: 'community', OV_OAUTH_CLIENT_SECRET: 'shh' };
        const script = path.join(__dirname, '..', 'scripts', 'import-pastes.js');
        const refused = spawnSync(process.execPath, [script, bad], { env, encoding: 'utf8' });
        assert.strictEqual(refused.status, 2, refused.stderr);
        assert.match(refused.stderr, /Refused: sha256 mismatch/);
        // Run the child asynchronously: the mock Network lives in this process's event loop.
        const { spawn } = require('child_process');
        const out = await new Promise((resolve) => {
            const child = spawn(process.execPath, [script, good, '--dry-run', '--id-fix-cutoff', '2026-08-20T03:00:26Z'], { env });
            let stdout = '', stderr = '';
            child.stdout.on('data', (c) => { stdout += c; });
            child.stderr.on('data', (c) => { stderr += c; });
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
        assert.strictEqual(out.code, 0, out.stderr);
        assert.match(out.stdout, /DRY RUN — rolled back/);
        // Live user 555 is mapped by now (previous check), so two pastes are held, not three.
        assert.match(out.stdout, /pastes\s+9\s+9\s+0\s+0\s+2\s+0/, out.stdout);
        const check2 = openDb(dbPath);
        assert.strictEqual(check2.prepare('SELECT COUNT(*) AS c FROM pastes').get().c, 0);
        assert.strictEqual(check2.prepare('SELECT COUNT(*) AS c FROM subject_projection').get().c, 0, 'not even the display cache');
        check2.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    db.close();
    await net.close();
    done();
})();
