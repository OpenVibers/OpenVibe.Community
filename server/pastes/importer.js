'use strict';

/**
 * Paste importer — OpenVibe.Media's paste export bundle → Community's store.
 *
 * Bundle (produced by Media, format openvibe.media.pastes-export v1):
 *   { format, version, app, generated_at, since_id, max_id, sha256, counts: {pastes, comments, likes},
 *     pastes: [...], comments: [...], likes: [...] }
 * sha256 is over JSON.stringify({ pastes, comments, likes }).
 *
 * Rules:
 *   - The bundle is verified (format, version, counts, sha256) before anything is touched.
 *   - Idempotent: rows are upserted by legacy_media_id, so a re-run changes nothing and a newer
 *     bundle adds and updates. A paste deleted in Community stays deleted.
 *   - Slugs, timestamps, counters, visibility, NSFW and AI fields are kept. Counters never go
 *     down (Community may have counted views since the last run).
 *   - Owners: bundle user_ids are Live user ids, except rows created before the id-space fix
 *     (cutoff) which may hold a Network user id instead. Every id is resolved through the Network
 *     (system=live, and system=network for pre-cutoff rows). Pre-cutoff with two different
 *     answers → imported ownerless + hold 'ambiguous_owner'; no answer → ownerless + hold
 *     'owner_unmapped'. A like that can't be mapped is held and not imported.
 *   - AI moment pastes (Live's AI jobs) get origin 'ai' and no owner: AI output is never
 *     attributed to a person. Their stream goes into stream_ref.
 *   - Every mapping lands in legacy_id_map; every run in migration_runs with a reconciliation report.
 *   - dryRun does all of it inside a transaction and rolls back.
 */
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const store = require('./store');

const FORMAT = 'openvibe.media.pastes-export';
const DEFAULT_CUTOFF = '2026-08-20T03:00:26Z';
// ac0d6a4 "Initial OpenVibe release" (2026-08-17 14:10:29 -07:00): earlier rows came from HoboStreamer's database.
const DEFAULT_AMBIGUOUS_FROM = '2026-08-17T21:10:29Z';
// Media rebuilt screenshot metadata itself, so the ai_moment flag Live sent was dropped for image
// pastes; the frame file names Live's AI jobs upload are the remaining marker.
const AI_FRAME_NAME = /^(ai-moment-vod\d+-\d+|live-\d+-\d+)\.jpe?g$/i;

class ImportError extends Error {}
class Rollback extends Error {}

function toMs(ts) {
    if (!ts) return NaN;
    const s = String(ts);
    return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`);
}

function objectOf(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } }
    return null;
}

function isAiPaste(p) {
    const meta = objectOf(p.metadata);
    if (meta && meta.ai_moment === true) return true;
    return p.type === 'screenshot' && !!meta && typeof meta.original_name === 'string' && AI_FRAME_NAME.test(meta.original_name);
}

/** Refuse a bundle that isn't exactly what it says it is. */
function verifyBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') throw new ImportError('bundle is not a JSON object');
    if (bundle.format !== FORMAT) throw new ImportError(`unexpected format ${JSON.stringify(bundle.format)} (want ${FORMAT})`);
    if (bundle.version !== 1) throw new ImportError(`unsupported version ${JSON.stringify(bundle.version)} (want 1)`);
    for (const k of ['pastes', 'comments', 'likes']) {
        if (!Array.isArray(bundle[k])) throw new ImportError(`bundle.${k} is not an array`);
        const want = bundle.counts && bundle.counts[k];
        if (want !== bundle[k].length) throw new ImportError(`count mismatch for ${k}: counts says ${want}, bundle has ${bundle[k].length}`);
    }
    const sha = crypto.createHash('sha256').update(JSON.stringify({ pastes: bundle.pastes, comments: bundle.comments, likes: bundle.likes })).digest('hex');
    if (sha !== String(bundle.sha256 || '').toLowerCase()) throw new ImportError(`sha256 mismatch: bundle says ${bundle.sha256}, content is ${sha}`);
}

/**
 * Import a verified bundle.
 *   opts.resolveLegacy(system, ids) → Map<String(id), projection|null>  (Network resolve-batch)
 *   opts.cutoff   ISO time of the id-space fix
 *   opts.dryRun   roll everything back at the end
 *   opts.source   label for migration_runs
 * → report
 */
async function importBundle(db, bundle, { resolveLegacy, cutoff = DEFAULT_CUTOFF, ambiguousFrom = DEFAULT_AMBIGUOUS_FROM, dryRun = false, source = 'media' } = {}) {
    verifyBundle(bundle);
    const cutoffMs = toMs(cutoff);
    if (!Number.isFinite(cutoffMs)) throw new ImportError(`bad cutoff ${cutoff}`);
    const fromMs = ambiguousFrom ? toMs(ambiguousFrom) : -Infinity;
    if (!Number.isFinite(fromMs) && fromMs !== -Infinity) throw new ImportError(`bad ambiguous-from ${ambiguousFrom}`);
    // Only rows written between the OpenVibe launch and the id-space fix can hold a Network id: rows from
    // before the launch were migrated from HoboStreamer's own database, whose user ids Live kept.
    const inWindow = (createdAt) => { const t = toMs(createdAt); return t >= fromMs && !(t >= cutoffMs); };
    const startedAt = new Date().toISOString();

    // ── 1. Resolve every legacy user id before the transaction (network calls) ──
    const liveIds = new Set();
    const preCutoffIds = new Set();
    const note = (userId, createdAt) => {
        if (userId == null) return;
        liveIds.add(String(userId));
        if (inWindow(createdAt)) preCutoffIds.add(String(userId));
    };
    for (const p of bundle.pastes) if (!isAiPaste(p)) note(p.user_id, p.created_at);
    for (const c of bundle.comments) note(c.user_id, c.created_at);
    for (const l of bundle.likes) note(l.user_id, l.created_at);
    const subjectOf = (proj) => (proj && proj.subject && proj.subject.type === 'user' ? proj.subject.id : null);
    const liveMap = liveIds.size ? await resolveLegacy('live', [...liveIds]) : new Map();
    const netMap = preCutoffIds.size ? await resolveLegacy('network', [...preCutoffIds]) : new Map();

    function owner(userId, createdAt) {
        if (userId == null) return { subject: null, hold: null };
        const key = String(userId);
        const live = subjectOf(liveMap.get(key));
        const pre = inWindow(createdAt);
        if (!pre) return live ? { subject: live, hold: null } : { subject: null, hold: 'owner_unmapped', detail: { user_id: userId, created_at: createdAt, era: 'post-cutoff' } };
        const net = subjectOf(netMap.get(key));
        if (live && net && live !== net) return { subject: null, hold: 'ambiguous_owner', detail: { user_id: userId, created_at: createdAt, live_subject: live, network_subject: net } };
        if (live || net) return { subject: live || net, hold: null };
        return { subject: null, hold: 'owner_unmapped', detail: { user_id: userId, created_at: createdAt, era: 'pre-cutoff' } };
    }

    const blank = () => ({ bundle: 0, inserted: 0, updated: 0, unchanged: 0, held: 0, skipped: 0 });
    const report = {
        source, app: bundle.app || null, generated_at: bundle.generated_at || null, since_id: bundle.since_id ?? null, max_id: bundle.max_id ?? null,
        cutoff, ambiguous_from: ambiguousFrom || null, dry_run: !!dryRun,
        pastes: { ...blank(), bundle: bundle.pastes.length, ai: 0, forks_remapped: 0, forks_unresolved: 0 },
        comments: { ...blank(), bundle: bundle.comments.length },
        likes: { ...blank(), bundle: bundle.likes.length },
        holds: {},
        users: { live_ids: liveIds.size, live_mapped: [...liveMap.values()].filter(subjectOf).length, network_checked: preCutoffIds.size, network_mapped: [...netMap.values()].filter(subjectOf).length },
    };
    const countHold = (reason) => { report.holds[reason] = (report.holds[reason] || 0) + 1; };

    const hold = db.prepare('INSERT OR IGNORE INTO import_hold (source_type, source_id, reason, detail) VALUES (?, ?, ?, ?)');
    const clearOwnerHolds = db.prepare("DELETE FROM import_hold WHERE source_type = ? AND source_id = ? AND reason IN ('ambiguous_owner', 'owner_unmapped')");
    const byLegacy = db.prepare('SELECT * FROM pastes WHERE legacy_media_id = ?');
    const slugOwner = db.prepare('SELECT id, legacy_media_id FROM pastes WHERE slug = ?');
    const commentByLegacy = db.prepare('SELECT * FROM paste_comments WHERE legacy_media_id = ?');

    const run = db.transaction(() => {
        // Users seen: record the mappings the Network gave us.
        for (const [id, proj] of liveMap) { const s = subjectOf(proj); if (s) store.mapSet(db, 'live', 'user', id, 'subject', s); }
        for (const [id, proj] of netMap) { const s = subjectOf(proj); if (s) store.mapSet(db, 'network', 'user', id, 'subject', s); }

        // ── 2. Pastes ──
        const PASTE_TEXT_FIELDS = ['type', 'title', 'content', 'language', 'visibility', 'screenshot_url', 'media_ref', 'stream_ref', 'metadata',
            'burn_after_read', 'pinned', 'is_nsfw', 'ai_summary', 'ai_tags', 'ai_analyzed_at', 'origin', 'updated_at'];
        const COUNTERS = ['views', 'unique_views', 'copies', 'likes'];
        for (const p of bundle.pastes) {
            const ai = isAiPaste(p);
            if (ai) report.pastes.ai++;
            const who = ai ? { subject: null, hold: null } : owner(p.user_id, p.created_at);
            const meta = objectOf(p.metadata);
            const streamId = p.stream_id != null ? p.stream_id : (meta && meta.stream_id != null ? meta.stream_id : null);
            const row = {
                slug: String(p.slug),
                origin: ai ? 'ai' : 'user',
                type: p.type === 'screenshot' ? 'screenshot' : 'paste',
                title: store.sanitizeTitle(p.title),
                content: p.content == null ? null : String(p.content),
                language: p.language || 'text',
                visibility: ['public', 'unlisted', 'private'].includes(p.visibility) ? p.visibility : 'public',
                screenshot_url: p.screenshot_url || null,
                media_ref: p.type === 'screenshot' ? ids.legacyMediaId(bundle.app || 'live', 'paste', p.id) : null,
                stream_ref: streamId != null && streamId !== '' ? JSON.stringify({ service: 'live', type: 'stream', id: String(streamId) }) : null,
                metadata: meta ? JSON.stringify(meta) : null,
                burn_after_read: p.burn_after_read ? 1 : 0,
                pinned: p.pinned ? 1 : 0,
                is_nsfw: p.is_nsfw ? 1 : 0,
                ai_summary: p.ai_summary || null,
                ai_tags: p.ai_tags == null ? null : (typeof p.ai_tags === 'string' ? p.ai_tags : JSON.stringify(p.ai_tags)),
                ai_analyzed_at: p.ai_analyzed_at || null,
                views: Number(p.views) || 0, unique_views: Number(p.unique_views) || 0, copies: Number(p.copies) || 0, likes: Number(p.likes) || 0,
                created_at: p.created_at, updated_at: p.updated_at || p.created_at,
            };
            const existing = byLegacy.get(p.id);
            let communityId;
            if (!existing) {
                const clash = slugOwner.get(row.slug);
                if (clash) {
                    hold.run('paste', String(p.id), 'slug_conflict', JSON.stringify({ slug: row.slug, community_id: clash.id }));
                    countHold('slug_conflict'); report.pastes.skipped++;
                    continue;
                }
                const cols = Object.keys(row).concat(['owner_subject', 'legacy_media_id', 'legacy_user_id']);
                const vals = Object.values(row).concat([who.subject, p.id, p.user_id == null ? null : Number(p.user_id)]);
                const info = db.prepare(`INSERT INTO pastes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
                communityId = info.lastInsertRowid;
                report.pastes.inserted++;
            } else {
                communityId = existing.id;
                if (existing.deleted_at) { report.pastes.unchanged++; store.mapSet(db, 'media', 'paste', p.id, 'paste', communityId); continue; }
                const patch = {};
                // Edited here since the last import? Then Community's text wins over the bundle's.
                const localNewer = existing.revision > 1 || toMs(existing.updated_at) > toMs(row.updated_at);
                if (!localNewer) for (const k of PASTE_TEXT_FIELDS) if (row[k] !== existing[k]) patch[k] = row[k];
                for (const k of COUNTERS) if (row[k] > existing[k]) patch[k] = row[k];
                if (who.subject && !existing.owner_subject) patch.owner_subject = who.subject;
                if (row.origin === 'ai' && existing.owner_subject && existing.origin !== 'ai') patch.owner_subject = null;
                const legacyUser = p.user_id == null ? null : Number(p.user_id);
                if (legacyUser !== existing.legacy_user_id) patch.legacy_user_id = legacyUser;
                const keys = Object.keys(patch);
                if (keys.length) {
                    db.prepare(`UPDATE pastes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), communityId);
                    report.pastes.updated++;
                } else {
                    report.pastes.unchanged++;
                }
            }
            store.mapSet(db, 'media', 'paste', p.id, 'paste', communityId);
            if (who.hold) {
                hold.run('paste', String(p.id), who.hold, JSON.stringify(who.detail));
                countHold(who.hold); report.pastes.held++;
            } else {
                clearOwnerHolds.run('paste', String(p.id));
            }
        }
        // Forks point at Community ids (second pass: the original may come later in the bundle).
        for (const p of bundle.pastes) {
            if (p.forked_from == null) continue;
            const target = store.mapGet(db, 'media', 'paste', p.forked_from);
            const self = store.mapGet(db, 'media', 'paste', p.id);
            if (!self) continue;
            if (!target) { report.pastes.forks_unresolved++; continue; }
            const changed = db.prepare('UPDATE pastes SET forked_from = ? WHERE id = ? AND forked_from IS NOT ?').run(Number(target.target_id), Number(self.target_id), Number(target.target_id)).changes;
            if (changed) report.pastes.forks_remapped++;
        }

        // ── 3. Comments ──
        const comments = bundle.comments.slice().sort((a, b) => a.id - b.id);
        for (const c of comments) {
            const paste = store.mapGet(db, 'media', 'paste', c.paste_id);
            if (!paste) {
                hold.run('comment', String(c.id), 'paste_missing', JSON.stringify({ paste_id: c.paste_id }));
                countHold('paste_missing'); report.comments.skipped++;
                continue;
            }
            const who = owner(c.user_id, c.created_at);
            const row = {
                paste_id: Number(paste.target_id), anon_name: c.anon_name || null, message: String(c.message == null ? '' : c.message),
                is_deleted: c.is_deleted ? 1 : 0, created_at: c.created_at, updated_at: c.updated_at || c.created_at,
            };
            const existing = commentByLegacy.get(c.id);
            let cid;
            if (!existing) {
                const info = db.prepare(`INSERT INTO paste_comments (paste_id, author_subject, anon_name, message, is_deleted, created_at, updated_at, legacy_media_id)
                                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(row.paste_id, who.subject, row.anon_name, row.message, row.is_deleted, row.created_at, row.updated_at, c.id);
                cid = info.lastInsertRowid;
                report.comments.inserted++;
            } else {
                cid = existing.id;
                const patch = {};
                for (const k of ['message', 'anon_name', 'updated_at']) if (row[k] !== existing[k]) patch[k] = row[k];
                // Deletion is one-way: a comment removed on either side stays removed.
                if (row.is_deleted && !existing.is_deleted) patch.is_deleted = 1;
                if (who.subject && !existing.author_subject) patch.author_subject = who.subject;
                const keys = Object.keys(patch);
                if (keys.length) {
                    db.prepare(`UPDATE paste_comments SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), cid);
                    report.comments.updated++;
                } else {
                    report.comments.unchanged++;
                }
            }
            store.mapSet(db, 'media', 'comment', c.id, 'comment', cid);
            if (who.hold) {
                hold.run('comment', String(c.id), who.hold, JSON.stringify(who.detail));
                countHold(who.hold); report.comments.held++;
            } else {
                clearOwnerHolds.run('comment', String(c.id));
            }
        }
        for (const c of comments) {
            if (c.parent_id == null) continue;
            const self = store.mapGet(db, 'media', 'comment', c.id);
            const parent = store.mapGet(db, 'media', 'comment', c.parent_id);
            if (self && parent) db.prepare('UPDATE paste_comments SET parent_id = ? WHERE id = ? AND parent_id IS NOT ?').run(Number(parent.target_id), Number(self.target_id), Number(parent.target_id));
        }

        // ── 4. Likes (only ever imported for a mapped person) ──
        for (const l of bundle.likes) {
            const key = `${l.paste_id}:${l.user_id}`;
            const paste = store.mapGet(db, 'media', 'paste', l.paste_id);
            if (!paste) {
                hold.run('like', key, 'paste_missing', JSON.stringify({ paste_id: l.paste_id, user_id: l.user_id }));
                countHold('paste_missing'); report.likes.skipped++;
                continue;
            }
            const who = l.user_id == null ? { subject: null, hold: 'owner_unmapped', detail: { user_id: null } } : owner(l.user_id, l.created_at);
            if (!who.subject) {
                hold.run('like', key, who.hold, JSON.stringify(who.detail));
                countHold(who.hold); report.likes.held++;
                continue;
            }
            clearOwnerHolds.run('like', key);
            const info = db.prepare('INSERT OR IGNORE INTO paste_likes (paste_id, subject_id, created_at) VALUES (?, ?, ?)').run(Number(paste.target_id), who.subject, l.created_at || null);
            if (info.changes) report.likes.inserted++; else report.likes.unchanged++;
        }

        report.finished_at = new Date().toISOString();
        db.prepare('INSERT INTO migration_runs (source, started_at, finished_at, report) VALUES (?, ?, ?, ?)')
            .run(source, startedAt, report.finished_at, JSON.stringify(report));
        if (dryRun) throw new Rollback();
    });

    try { run(); } catch (err) { if (!(err instanceof Rollback)) throw err; }
    return report;
}

/** Plain-text reconciliation table. */
function formatReport(r) {
    const line = (name, t) => `  ${name.padEnd(9)} ${String(t.bundle).padStart(7)} ${String(t.inserted).padStart(9)} ${String(t.updated).padStart(8)} ${String(t.unchanged).padStart(10)} ${String(t.held).padStart(6)} ${String(t.skipped).padStart(8)}`;
    const out = [
        `Paste import from ${r.source}${r.dry_run ? '  (DRY RUN — rolled back)' : ''}`,
        `  bundle app=${r.app} ids ${r.since_id ?? '?'}..${r.max_id ?? '?'} generated ${r.generated_at || '?'}; ambiguous id window ${r.ambiguous_from || 'start'} .. ${r.cutoff}`,
        '',
        `  ${'table'.padEnd(9)} ${'bundle'.padStart(7)} ${'inserted'.padStart(9)} ${'updated'.padStart(8)} ${'unchanged'.padStart(10)} ${'held'.padStart(6)} ${'skipped'.padStart(8)}`,
        line('pastes', r.pastes), line('comments', r.comments), line('likes', r.likes),
        '',
        `  AI pastes (ownerless): ${r.pastes.ai}; forks remapped: ${r.pastes.forks_remapped}, unresolved: ${r.pastes.forks_unresolved}`,
        `  users: ${r.users.live_ids} live ids (${r.users.live_mapped} mapped), ${r.users.network_checked} in-window ids checked as network ids (${r.users.network_mapped} mapped)`,
        `  holds: ${Object.keys(r.holds).length ? Object.entries(r.holds).map(([k, v]) => `${k}=${v}`).join(', ') : 'none'}`,
    ];
    return out.join('\n');
}

module.exports = { DEFAULT_AMBIGUOUS_FROM, importBundle, verifyBundle, formatReport, isAiPaste, ImportError, FORMAT, DEFAULT_CUTOFF };
