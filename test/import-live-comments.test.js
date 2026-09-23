'use strict';
/**
 * Live's own VOD/clip comments → Community threads (server/comments/live-import.js and
 * scripts/import-live-comments.js): reconciliation (read = imported + held + excluded), authors
 * from Live's links and the Network's identity map (unmapped and disagreeing ones held), replies
 * nested one level, times and edits kept, the ledger making re-runs import nothing twice, held rows
 * imported once their author maps, dry run writing nothing, and --apply refusing without a backup.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { check, done } = require('./helpers/app');

process.env.NODE_ENV = 'test';
const { openDb } = require('../server/db');
const { importLiveComments, formatReport } = require('../server/comments/live-import');
const { createCommentService } = require('../server/comments/service');

const A = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPA';   // live user 1, linked on Live
const B = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPB';   // live user 2, Network map only
const C = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPC';   // live user 4 per Live's link…
const D = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPD';   // …and per the Network: they disagree
const E = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPE';   // live user 3, linked later

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-live-comments-'));
const livePath = path.join(dir, 'live.db');
const live = new Database(livePath);
live.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE linked_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, service TEXT, service_user_id TEXT, subject_id TEXT);
CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, content_type TEXT NOT NULL CHECK(content_type IN ('vod', 'clip')), content_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, parent_id INTEGER, message TEXT NOT NULL, is_deleted INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (1, 'network', '101', ?)").run(A);
live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (4, 'network', '104', ?)").run(C);
live.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (2, 'twitch', 'x', NULL)").run();
const add = (id, type, cid, uid, parent, message, extra = {}) => live.prepare(`INSERT INTO comments (id, content_type, content_id, user_id, parent_id, message, is_deleted, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, type, cid, uid, parent, message, extra.deleted ? 1 : 0, extra.created || `2026-08-0${Math.min(id, 9)} 10:00:00`, extra.updated || extra.created || `2026-08-0${Math.min(id, 9)} 10:00:00`);
add(1, 'vod', 10, 1, null, 'first');
add(2, 'vod', 10, 2, 1, 'a reply');
add(3, 'vod', 10, 1, 2, 'reply to the reply');
add(4, 'vod', 10, 3, null, 'by someone unmapped');
add(5, 'vod', 10, 1, 4, 'under the held one');
add(6, 'clip', 20, 4, null, 'two answers for this author');
add(7, 'clip', 20, 1, null, 'deleted on live', { deleted: true });
add(8, 'clip', 20, 2, 7, 'reply under a deleted comment');
add(9, 'clip', 20, 1, null, 'edited once', { created: '2026-08-09 10:00:00', updated: '2026-08-09 11:30:00' });
add(10, 'vod', 11, 1, 99, 'parent missing');
add(11, 'vod', 10, 2, 9, 'parent on other content');
add(12, 'vod', 12, 1, null, '   ');
live.close();

const networkMap = { 2: B, 4: D };
const calls = [];
const resolveLegacy = async (system, ids) => {
    calls.push({ system, ids });
    return new Map(ids.map((id) => [id, networkMap[id] ? { subject: { type: 'user', id: networkMap[id] } } : null]));
};

(async () => {
    const db = openDb(':memory:');
    const liveRo = new Database(livePath, { readonly: true });
    const count = (sql, ...a) => db.prepare(sql).get(...a).n;
    const threadOf = (type, id) => db.prepare("SELECT * FROM comment_threads WHERE ref_service = 'live' AND ref_type = ? AND ref_id = ?").get(type, String(id));

    await check('dry run (the default): the full report, nothing written', async () => {
        const r = await importLiveComments(db, liveRo, { resolveLegacy });
        assert.strictEqual(r.dry_run, true);
        assert.deepStrictEqual([r.read, r.imported, r.held, r.excluded], [12, 4, 3, 5]);
        assert.strictEqual(r.reconciled, true);
        assert.deepStrictEqual(r.excluded_by_reason, { deleted: 1, parent_deleted: 1, orphan: 2, empty: 1 });
        assert.deepStrictEqual(r.held_rows.map((h) => [h.live_id, h.reason]), [[4, 'unmapped_author'], [6, 'ambiguous_author'], [5, 'parent_held']]);
        assert.deepStrictEqual(calls[0], { system: 'live', ids: ['1', '2', '3', '4'] }, 'only authors of importable rows are looked up');
        for (const table of ['comments', 'comment_threads', 'legacy_id_map', 'import_hold', 'migration_runs']) {
            assert.strictEqual(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} untouched`);
        }
        const text = formatReport(r);
        assert.match(text, /DRY RUN/);
        assert.match(text, /read 12 = imported 4 \+ held 3 \+ excluded 5 → OK/);
        assert.match(text, /live comment 4 {2}unmapped_author {2}on vod\/10 {2}live user 3/);
    });

    await check('apply: threads per VOD/clip, authors as subjects, one level of nesting, times and edits kept, counters, holds, a run record', async () => {
        const r = await importLiveComments(db, liveRo, { resolveLegacy, dryRun: false, source: 'live.db' });
        assert.deepStrictEqual([r.read, r.imported_new, r.imported_before, r.held, r.excluded], [12, 4, 0, 3, 5]);
        const vod = threadOf('vod', 10), clip = threadOf('clip', 20);
        assert.ok(vod && clip && !threadOf('vod', 11) && !threadOf('vod', 12), 'threads only where something was imported');
        assert.strictEqual(r.threads.length, 2);
        assert.strictEqual(vod.comment_count, 3);
        assert.strictEqual(clip.comment_count, 1);
        const idOf = (liveId) => Number(db.prepare("SELECT target_id FROM legacy_id_map WHERE source_system = 'live' AND source_type = 'comment' AND source_id = ?").get(String(liveId)).target_id);
        const row = (liveId) => db.prepare('SELECT * FROM comments WHERE id = ?').get(idOf(liveId));
        assert.deepStrictEqual([row(1).author_subject, row(1).parent_id, row(1).message, row(1).created_at, row(1).edited_at], [A, null, 'first', '2026-08-01 10:00:00', null]);
        assert.deepStrictEqual([row(2).author_subject, row(2).parent_id], [B, idOf(1)], 'a Network-only author');
        assert.strictEqual(row(3).parent_id, idOf(1), 'a reply to a reply joins the top-level comment');
        assert.strictEqual(row(1).reply_count, 2);
        assert.deepStrictEqual([row(9).created_at, row(9).edited_at], ['2026-08-09 10:00:00', '2026-08-09 11:30:00']);
        assert.strictEqual(row(9).origin, 'user');
        const holds = db.prepare("SELECT source_id, reason FROM import_hold WHERE source_type = 'live_comment' ORDER BY source_id").all();
        assert.deepStrictEqual(holds.map((h) => [h.source_id, h.reason]), [['4', 'unmapped_author'], ['5', 'parent_held'], ['6', 'ambiguous_author']]);
        assert.strictEqual(count("SELECT COUNT(*) AS n FROM migration_runs WHERE source = 'live-comments:live.db'"), 1);

        // What Live's adapter reads back: newest first, replies nested, edits marked.
        const svc = createCommentService({ db });
        const page = await svc.get({ kind: 'service', service: 'svc:live', claims: { cap: ['community.comment.write'] }, subject: null }, vod.id, { sort: 'new' });
        assert.deepStrictEqual(page.comments.map((c) => c.message), ['first']);
        assert.deepStrictEqual(page.comments[0].replies.map((c) => c.message), ['a reply', 'reply to the reply']);
        const clipPage = await svc.get({ kind: 'service', service: 'svc:live', claims: { cap: ['community.comment.write'] }, subject: null }, clip.id, {});
        assert.strictEqual(clipPage.comments[0].edited_at, '2026-08-09T11:30:00.000Z');
    });

    await check('the ledger: a second run imports nothing twice', async () => {
        const before = count('SELECT COUNT(*) AS n FROM comments');
        const r = await importLiveComments(db, liveRo, { resolveLegacy, dryRun: false });
        assert.deepStrictEqual([r.imported_new, r.imported_before, r.held, r.excluded, r.reconciled], [0, 4, 3, 5, true]);
        assert.strictEqual(count('SELECT COUNT(*) AS n FROM comments'), before);
        assert.strictEqual(threadOf('vod', 10).comment_count, 3);
    });

    await check('held rows import once their author maps; their holds are cleared; replies follow', async () => {
        const rw = new Database(livePath);
        rw.prepare("INSERT INTO linked_accounts (user_id, service, service_user_id, subject_id) VALUES (3, 'network', '103', ?)").run(E);
        rw.close();
        const r = await importLiveComments(db, liveRo, { resolveLegacy, dryRun: false });
        assert.deepStrictEqual([r.imported_new, r.imported_before, r.held, r.excluded], [2, 4, 1, 5]);
        assert.deepStrictEqual(db.prepare("SELECT source_id, reason FROM import_hold WHERE source_type = 'live_comment'").all(), [{ source_id: '6', reason: 'ambiguous_author' }]);
        assert.strictEqual(threadOf('vod', 10).comment_count, 5);
        const liveIdOf = (communityId) => db.prepare("SELECT source_id FROM legacy_id_map WHERE source_system = 'live' AND source_type = 'comment' AND target_id = ?").get(String(communityId)).source_id;
        const reply = db.prepare("SELECT * FROM comments WHERE message = 'under the held one'").get();
        assert.strictEqual(liveIdOf(reply.parent_id), '4');
    });

    await check('Live links only (no Network call): the Network-only author is held', async () => {
        const fresh = openDb(':memory:');
        const r = await importLiveComments(fresh, liveRo, { resolveLegacy: null });
        assert.strictEqual(r.reconciled, true);
        assert.ok(r.held_rows.some((h) => h.live_id === 2 && h.reason === 'unmapped_author'));
        assert.ok(!r.held_rows.some((h) => h.live_id === 3), 'a reply to it joins the top-level comment, which is not held');
        assert.ok(!r.held_rows.some((h) => h.live_id === 6), 'with one source there is nothing to disagree');
        fresh.close();
    });

    await check('the script: dry run by default; --apply refused without --backup; the backup is taken and checked; re-runs are no-ops', async () => {
        const communityPath = path.join(dir, 'community.db');
        openDb(communityPath).close();
        const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-live-comments.js'), ...args], {
            cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, COMMUNITY_DB_PATH: communityPath, OV_OAUTH_CLIENT_SECRET: '' },
        });
        const base = ['--live-db', livePath, '--community-db', communityPath, '--live-links-only'];
        const dry = run(...base);
        assert.strictEqual(dry.status, 0, dry.stderr);
        assert.match(dry.stdout, /DRY RUN/);
        assert.match(dry.stdout, /Nothing was written/);
        const peek = () => { const d = new Database(communityPath, { readonly: true }); const n = d.prepare('SELECT COUNT(*) AS n FROM comments').get().n; d.close(); return n; };
        assert.strictEqual(peek(), 0);
        const noBackup = run(...base, '--apply');
        assert.strictEqual(noBackup.status, 2);
        assert.match(noBackup.stderr, /--apply needs --backup/);
        assert.strictEqual(peek(), 0);
        const backup = path.join(dir, 'community-before.db');
        const applied = run(...base, '--apply', '--backup', backup);
        assert.strictEqual(applied.status, 0, applied.stderr);
        assert.match(applied.stdout, /Backup: .*community-before\.db \(integrity ok; 0 comments in 0 threads\)/);
        assert.match(applied.stdout, /APPLIED/);
        assert.ok(fs.existsSync(backup));
        const imported = peek();
        assert.ok(imported > 0);
        const again = run(...base, '--apply', '--backup', backup);
        assert.strictEqual(again.status, 2, 'an existing backup file is never overwritten');
        const again2 = run(...base, '--apply', '--backup', path.join(dir, 'community-before-2.db'));
        assert.strictEqual(again2.status, 0, again2.stderr);
        assert.match(again2.stdout, /new 0, already imported/);
        assert.strictEqual(peek(), imported);
        const missing = run('--live-db', path.join(dir, 'nope.db'), '--community-db', communityPath);
        assert.strictEqual(missing.status, 2);
    });

    liveRo.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})();
