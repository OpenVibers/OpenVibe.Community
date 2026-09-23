'use strict';

/**
 * OpenVibe.Live's own VOD and clip comments (live.db `comments`) → Community comment threads.
 *
 * Live used to keep comments on VODs and clips in its own table; they are now the Community
 * threads of EntityRef { service: 'live', type: 'vod'|'clip', id } (Live's /api/comments is an
 * adapter over them). This moves the old rows across, once, keeping their times and text.
 *
 * Every Live row ends up in exactly one bucket, so the report reconciles:
 *
 *   read = imported (new this run + already imported by an earlier run) + held + excluded
 *
 *   imported   the comment is in its thread; legacy_id_map ('live','comment',<live id>) → the
 *              Community comment id is the ledger, so a second run imports nothing twice
 *   held       the author could not be named as a Network subject (unmapped_author), or two
 *              sources named different subjects (ambiguous_author), or its parent comment is held
 *              (parent_held). Recorded in import_hold ('live_comment', <live id>, reason) and
 *              listed; a later run imports them once the mapping exists (and clears the hold)
 *   excluded   deleted on Live (deleted), a reply under a deleted comment (parent_deleted, Live
 *              no longer showed those), a parent that is missing or on other content (orphan),
 *              an empty message (empty) or a target type other than vod/clip (bad_target)
 *
 * Authors: Live's linked_accounts(service='network').subject_id (written from verified Network
 * tokens) and the Network's identity map (resolve-batch, system 'live', type 'user'). Either one
 * is enough; when both answer they must agree.
 *
 * Replies nest one level in Community: a Live reply to a reply joins its top-level comment.
 * A row Live marked edited (updated_at later than created_at) keeps that time as edited_at.
 * Live's database is only read. With dryRun (the default) everything runs in a transaction that
 * is rolled back, so the report is exactly what --apply would do.
 */
const store = require('./store');

const SOURCE_TYPE = 'live_comment';
const LEDGER = ['live', 'comment'];
const IMPORTER = 'import:live-comments';

class LiveImportError extends Error {}

function readLive(liveDb) {
    const tables = new Set(liveDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tables.has('comments')) throw new LiveImportError('the Live database has no comments table');
    const rows = liveDb.prepare(`SELECT id, content_type, content_id, user_id, parent_id, message, is_deleted, created_at, updated_at
                                 FROM comments ORDER BY id`).all();
    const links = new Map();
    if (tables.has('linked_accounts')) {
        const cols = new Set(liveDb.prepare('PRAGMA table_info(linked_accounts)').all().map((c) => c.name));
        if (cols.has('subject_id')) {
            for (const r of liveDb.prepare("SELECT user_id, subject_id FROM linked_accounts WHERE service = 'network' AND subject_id IS NOT NULL").all()) {
                links.set(String(r.user_id), r.subject_id);
            }
        }
    }
    return { rows, links };
}

/** Live's SQLite times are UTC 'YYYY-MM-DD HH:MM:SS'; keep them in that form. */
function sqlTime(v) {
    if (!v) return null;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s;
    const d = new Date(/^\d{4}-\d{2}-\d{2}T/.test(s) || /Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
}

const USER_SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * opts.resolveLegacy(system, ids) → Map(id → { subject: { type, id } } | null) (Network), or null
 * to rely on Live's own links only. opts.dryRun (default true). opts.source names the run.
 */
async function importLiveComments(db, liveDb, { resolveLegacy = null, dryRun = true, source = 'live.db' } = {}) {
    const { rows, links } = readLive(liveDb);
    const byId = new Map(rows.map((r) => [r.id, r]));

    // ── Classify: excluded rows first (they need no author) ──
    const excluded = new Map();              // live id → reason
    const rootOf = new Map();                // live id → top-level live id
    for (const r of rows) {
        if (r.is_deleted) { excluded.set(r.id, 'deleted'); continue; }
        if (!['vod', 'clip'].includes(r.content_type) || !(Number(r.content_id) > 0)) { excluded.set(r.id, 'bad_target'); continue; }
        if (!String(r.message || '').trim()) { excluded.set(r.id, 'empty'); continue; }
        let cur = r, reason = null;
        const seen = new Set([r.id]);
        while (cur.parent_id != null) {
            const p = byId.get(cur.parent_id);
            if (!p || seen.has(p.id) || p.content_type !== r.content_type || p.content_id !== r.content_id) { reason = 'orphan'; break; }
            if (p.is_deleted) { reason = 'parent_deleted'; break; }
            seen.add(p.id);
            cur = p;
        }
        if (reason) excluded.set(r.id, reason);
        else rootOf.set(r.id, cur.id);
    }

    // ── Authors → subjects ──
    const userIds = [...new Set(rows.filter((r) => rootOf.has(r.id)).map((r) => String(r.user_id)))];
    let network = new Map();
    if (resolveLegacy && userIds.length) network = await resolveLegacy('live', userIds);
    const subjectFor = new Map();            // live user id → { subject } | { reason, detail }
    for (const uid of userIds) {
        const hit = network.get(uid);
        const fromNet = hit && hit.subject && hit.subject.type === 'user' && USER_SUBJECT.test(hit.subject.id) ? hit.subject.id : null;
        const fromLive = USER_SUBJECT.test(String(links.get(uid) || '')) ? links.get(uid) : null;
        if (fromNet && fromLive && fromNet !== fromLive) subjectFor.set(uid, { reason: 'ambiguous_author', detail: `network says ${fromNet}, Live's link says ${fromLive}` });
        else if (fromNet || fromLive) subjectFor.set(uid, { subject: fromNet || fromLive });
        else subjectFor.set(uid, { reason: 'unmapped_author', detail: `live user ${uid} has no Network subject` });
    }

    const report = {
        source, dry_run: !!dryRun, read: rows.length,
        imported: 0, imported_new: 0, imported_before: 0, held: 0, excluded: 0,
        excluded_by_reason: {}, held_rows: [], threads: [], reconciled: false,
    };

    const ledger = db.prepare('SELECT target_id FROM legacy_id_map WHERE source_system = ? AND source_type = ? AND source_id = ?');
    const ledgerGet = (liveId) => {
        const hit = ledger.get(LEDGER[0], LEDGER[1], String(liveId));
        return hit ? Number(hit.target_id) : null;
    };
    const ledgerSet = db.prepare(`INSERT INTO legacy_id_map (source_system, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, 'comment', ?)
                                  ON CONFLICT(source_system, source_type, source_id) DO NOTHING`);
    const hold = db.prepare(`INSERT INTO import_hold (source_type, source_id, reason, detail) VALUES (?, ?, ?, ?)
                             ON CONFLICT(source_type, source_id, reason) DO UPDATE SET detail = excluded.detail`);
    const unhold = db.prepare('DELETE FROM import_hold WHERE source_type = ? AND source_id = ?');
    const insert = db.prepare(`INSERT INTO comments (thread_id, parent_id, author_subject, anon_name, origin, message, created_at, updated_at, edited_at)
                               VALUES (?, ?, ?, NULL, 'user', ?, ?, ?, ?)`);

    const apply = () => {
        const touchedThreads = new Set();
        const touchedParents = new Set();
        const threadIds = new Map();         // 'vod:12' → thread row
        const threadFor = (r) => {
            const key = `${r.content_type}:${r.content_id}`;
            if (!threadIds.has(key)) {
                const { thread } = store.resolveThread(db, { service: 'live', type: r.content_type, id: String(r.content_id) }, { createdBy: IMPORTER });
                threadIds.set(key, thread);
            }
            return threadIds.get(key);
        };
        const state = new Map();             // live id → 'imported' | 'held'

        // Top-level comments first, then replies (whose parent must be placed already).
        const ordered = rows.filter((r) => rootOf.has(r.id)).sort((a, b) => ((a.parent_id == null ? 0 : 1) - (b.parent_id == null ? 0 : 1)) || (a.id - b.id));
        for (const r of ordered) {
            const root = rootOf.get(r.id);
            const who = subjectFor.get(String(r.user_id));
            let heldReason = who.subject ? null : who.reason;
            let detail = who.subject ? null : who.detail;
            if (!heldReason && root !== r.id && state.get(root) === 'held') { heldReason = 'parent_held'; detail = `parent comment ${root} is held`; }
            if (heldReason) {
                state.set(r.id, 'held');
                unhold.run(SOURCE_TYPE, String(r.id));   // one current reason per row
                hold.run(SOURCE_TYPE, String(r.id), heldReason, JSON.stringify({ detail, content_type: r.content_type, content_id: r.content_id, user_id: r.user_id }));
                report.held_rows.push({ live_id: r.id, reason: heldReason, content: `${r.content_type}/${r.content_id}`, live_user_id: r.user_id, detail });
                continue;
            }
            const thread = threadFor(r);
            if (!report.threads.includes(thread.access_id)) report.threads.push(thread.access_id);
            const known = ledgerGet(r.id);
            if (known) { state.set(r.id, 'imported'); report.imported_before++; continue; }
            const parentCommunityId = root === r.id ? null : ledgerGet(root);
            const created = sqlTime(r.created_at) || sqlTime(new Date().toISOString());
            const updated = sqlTime(r.updated_at) || created;
            const edited = updated > created ? updated : null;
            const info = insert.run(thread.id, parentCommunityId, who.subject, String(r.message).trim(), created, updated, edited);
            ledgerSet.run(LEDGER[0], LEDGER[1], String(r.id), String(info.lastInsertRowid));
            unhold.run(SOURCE_TYPE, String(r.id));
            state.set(r.id, 'imported');
            report.imported_new++;
            touchedThreads.add(thread.id);
            if (parentCommunityId) touchedParents.add(parentCommunityId);
        }

        // Counters from the rows (the store keeps them in step for live writes; here we set them once).
        for (const id of touchedThreads) {
            db.prepare('UPDATE comment_threads SET comment_count = (SELECT COUNT(*) FROM comments WHERE thread_id = ? AND deleted_at IS NULL), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id, id);
        }
        for (const id of touchedParents) {
            db.prepare('UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND deleted_at IS NULL) WHERE id = ?').run(id, id);
        }

        report.imported = report.imported_new + report.imported_before;
        report.held = report.held_rows.length;
        for (const reason of excluded.values()) report.excluded_by_reason[reason] = (report.excluded_by_reason[reason] || 0) + 1;
        report.excluded = excluded.size;
        report.reconciled = report.read === report.imported + report.held + report.excluded;
        if (!report.reconciled) throw new LiveImportError(`reconciliation failed: read ${report.read} ≠ imported ${report.imported} + held ${report.held} + excluded ${report.excluded}`);
        if (!dryRun) {
            db.prepare('INSERT INTO migration_runs (source, finished_at, report) VALUES (?, CURRENT_TIMESTAMP, ?)').run(`live-comments:${source}`, JSON.stringify(report));
        }
    };

    const ROLLBACK = Symbol('dry run');
    try {
        db.transaction(() => { apply(); if (dryRun) throw ROLLBACK; })();
    } catch (err) {
        if (err !== ROLLBACK) throw err;
    }
    return report;
}

function formatReport(r) {
    const lines = [];
    lines.push(`Live comments → Community threads (${r.dry_run ? 'DRY RUN — nothing was written' : 'APPLIED'}) from ${r.source}`);
    lines.push(`  read      ${r.read}`);
    lines.push(`  imported  ${r.imported}  (new ${r.imported_new}, already imported ${r.imported_before})`);
    lines.push(`  held      ${r.held}`);
    lines.push(`  excluded  ${r.excluded}${Object.keys(r.excluded_by_reason).length ? `  (${Object.entries(r.excluded_by_reason).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
    lines.push(`  check     read ${r.read} = imported ${r.imported} + held ${r.held} + excluded ${r.excluded} → ${r.reconciled ? 'OK' : 'MISMATCH'}`);
    lines.push(`  threads   ${r.threads.length}`);
    if (r.held_rows.length) {
        lines.push('  held rows (not imported; re-run once the author has a Network subject):');
        for (const h of r.held_rows) lines.push(`    live comment ${h.live_id}  ${h.reason}  on ${h.content}  live user ${h.live_user_id}${h.detail ? `  — ${h.detail}` : ''}`);
    }
    return lines.join('\n');
}

module.exports = { importLiveComments, formatReport, LiveImportError, SOURCE_TYPE };
