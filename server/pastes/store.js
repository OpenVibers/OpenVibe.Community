'use strict';

/**
 * Paste store — pure database functions over Community's own tables (server/db.js).
 *
 * No HTTP, no identity resolution, no policy: every function takes the database handle first
 * and does exactly the SQL its name says (parameterized, always). Who may call what, rate
 * limits and response shaping live in service.js.
 *
 * Deleted pastes are soft-deleted (deleted_at set, content scrubbed) so their slug and legacy id
 * stay reserved and a re-import can never bring them back; every read below skips them.
 */
const crypto = require('crypto');

// ── Slugs (the same adjective-noun-number style OpenVibe.Media has always minted) ──
const SLUG_ADJECTIVES = [
    'amber', 'blue', 'bold', 'brave', 'bright', 'calm', 'clean', 'clever',
    'cold', 'cool', 'coral', 'crisp', 'dark', 'dawn', 'deep', 'dry',
    'dusk', 'dusty', 'fair', 'fast', 'fierce', 'fine', 'foggy', 'free',
    'fresh', 'frost', 'glad', 'gold', 'grand', 'gray', 'green', 'grim',
    'hazy', 'heavy', 'hidden', 'hollow', 'honey', 'hot', 'icy', 'iron',
    'jade', 'keen', 'kind', 'late', 'lazy', 'light', 'lime', 'lit',
    'lone', 'lost', 'loud', 'lucky', 'lush', 'mild', 'misty', 'mossy',
    'muddy', 'neon', 'new', 'noble', 'odd', 'old', 'opal', 'open',
    'pale', 'pink', 'plain', 'plum', 'prime', 'proud', 'pure', 'quick',
    'quiet', 'rare', 'raw', 'red', 'rich', 'rocky', 'rosy', 'rough',
    'ruby', 'rusty', 'safe', 'sage', 'sandy', 'sharp', 'shy', 'silver',
    'slim', 'slow', 'smoky', 'snowy', 'soft', 'sour', 'steep', 'still',
    'stone', 'sunny', 'sweet', 'swift', 'tall', 'tame', 'teal', 'thin',
    'tidy', 'tiny', 'torn', 'vast', 'vivid', 'warm', 'wavy', 'west',
    'wet', 'white', 'wide', 'wild', 'windy', 'wise', 'worn', 'young',
];
const SLUG_NOUNS = [
    'acorn', 'arch', 'arrow', 'aspen', 'badger', 'basil', 'bay', 'bear',
    'birch', 'blade', 'bloom', 'bolt', 'brook', 'brush', 'cairn', 'cave',
    'cedar', 'cliff', 'cloud', 'clover', 'coast', 'coral', 'crane', 'creek',
    'crow', 'dale', 'deer', 'delta', 'dew', 'dock', 'dove', 'drift',
    'drum', 'dune', 'eagle', 'echo', 'edge', 'elm', 'ember', 'fawn',
    'fern', 'field', 'finch', 'flame', 'flare', 'flint', 'fog', 'ford',
    'forge', 'fox', 'frost', 'gale', 'gate', 'gem', 'glen', 'goat',
    'grove', 'gull', 'hawk', 'haze', 'heath', 'hedge', 'heron', 'hill',
    'holly', 'horse', 'hound', 'isle', 'ivy', 'jade', 'jay', 'kelp',
    'lake', 'lark', 'leaf', 'ledge', 'lily', 'lion', 'lodge', 'lynx',
    'maple', 'marsh', 'mesa', 'mill', 'mint', 'mist', 'moon', 'moss',
    'moth', 'mule', 'nest', 'oak', 'orca', 'otter', 'owl', 'palm',
    'path', 'peak', 'pearl', 'petal', 'pike', 'pine', 'plum', 'pond',
    'quail', 'rain', 'raven', 'reed', 'reef', 'ridge', 'river', 'robin',
    'root', 'rose', 'sage', 'seal', 'shade', 'shell', 'shore', 'slate',
    'snail', 'spark', 'stone', 'storm', 'stork', 'thorn', 'tide', 'trail',
    'trout', 'tulip', 'vale', 'vine', 'viper', 'wave', 'wren', 'wolf',
];

const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_CHARS = 16;     // 62^16 ≈ 2^95, on top of the words

/**
 * A free slug. Deleted pastes keep theirs, so an old link never points somewhere new.
 *
 * Public pastes get a short adj-noun-NN slug (listed anyway, so nothing to guess). An unlisted or
 * private paste's slug is the only thing keeping it unlisted, so `secret` adds 16 random base62
 * characters (adj-noun-XXXXXXXXXXXXXXXX): the ~1.5M word/number slugs could be walked, these
 * cannot. Existing slugs never change.
 */
function generateSlug(db, { secret = false } = {}) {
    const taken = db.prepare('SELECT 1 FROM pastes WHERE slug = ?');
    const words = () => `${SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)]}-${SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)]}`;
    if (secret) {
        for (let i = 0; i < 10; i++) {
            let tail = '';
            for (let j = 0; j < SECRET_CHARS; j++) tail += SECRET_ALPHABET[crypto.randomInt(SECRET_ALPHABET.length)];
            const slug = `${words()}-${tail}`;
            if (!taken.get(slug)) return slug;
        }
        throw new Error('Could not generate a unique paste slug');
    }
    for (let i = 0; i < 10; i++) {
        const slug = `${SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)]}-${SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)]}-${crypto.randomInt(10, 100)}`;
        if (!taken.get(slug)) return slug;
    }
    // ~180k combinations; if ten draws all collide, widen the number rather than fail.
    for (let i = 0; i < 10; i++) {
        const slug = `${SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)]}-${SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)]}-${crypto.randomInt(100, 10000)}`;
        if (!taken.get(slug)) return slug;
    }
    throw new Error('Could not generate a unique paste slug');
}

function sanitizeTitle(title) {
    return String(title == null ? '' : title).trim().slice(0, 200) || 'Untitled';
}

/** Media's language sniffing, unchanged: an explicit hint wins unless it is 'auto'. */
function detectLanguage(content, hint) {
    if (hint && hint !== 'auto') return String(hint).slice(0, 32);
    const first = String(content || '').slice(0, 500);
    if (/^<(!DOCTYPE|html|div|span|head|body)/im.test(first)) return 'html';
    if (/^(import |from |const |let |var |function |=>|class )/m.test(first)) return 'javascript';
    if (/^(def |class |import |from |print\(|if __name__)/m.test(first)) return 'python';
    if (/^(package |func |import \(|fmt\.)/m.test(first)) return 'go';
    if (/^\{[\s\n]*"/.test(first)) return 'json';
    if (/^---\n|^[a-z_]+:\s/m.test(first)) return 'yaml';
    if (/^#!\/(bin|usr)/m.test(first)) return 'bash';
    if (/```|^#{1,6} |^\* |\*\*|^\[.*\]\(.*\)/m.test(first)) return 'markdown';
    if (/^(SELECT|INSERT|CREATE|ALTER|DROP|UPDATE|DELETE)\s/im.test(first)) return 'sql';
    if (/^<\?php/m.test(first)) return 'php';
    if (/^(use |fn |let mut |pub |impl |struct )/m.test(first)) return 'rust';
    return 'text';
}

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// ── Pastes ───────────────────────────────────────────────────

function getBySlug(db, slug) {
    return db.prepare('SELECT * FROM pastes WHERE slug = ? AND deleted_at IS NULL').get(String(slug)) || null;
}

function getById(db, id) {
    return db.prepare('SELECT * FROM pastes WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

const INSERT_COLUMNS = ['slug', 'owner_subject', 'origin', 'type', 'title', 'content', 'language', 'visibility',
    'screenshot_url', 'media_ref', 'stream_ref', 'metadata', 'burn_after_read', 'forked_from', 'pinned', 'is_nsfw',
    'ai_summary', 'ai_tags', 'ai_analyzed_at'];

/** Insert a new paste (fields already validated); returns the stored row. */
function insertPaste(db, fields) {
    const cols = INSERT_COLUMNS.filter((c) => fields[c] !== undefined);
    return db.transaction(() => {
        const info = db.prepare(`INSERT INTO pastes (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            .run(...cols.map((c) => fields[c]));
        const row = getById(db, info.lastInsertRowid);
        require('../events').pasteCreated(row);   // community.paste.created, in this transaction
        return row;
    })();
}

/**
 * Apply an edit. `patch` may hold title/content/language/visibility/is_nsfw/pinned. A change to
 * title, content or language bumps the revision and appends a paste_versions row; the first
 * edit also snapshots the original as revision 1, so the history is complete without storing a
 * copy of every paste that is never edited.
 */
function updatePaste(db, id, patch, editedBy = null) {
    return db.transaction(() => {
        const cur = getById(db, id);
        if (!cur) return null;
        const sets = [];
        const params = [];
        for (const k of ['title', 'content', 'language', 'visibility', 'is_nsfw', 'pinned']) {
            if (patch[k] === undefined) continue;
            sets.push(`${k} = ?`);
            params.push(patch[k]);
        }
        const textChanged = ['title', 'content', 'language'].some((k) => patch[k] !== undefined && patch[k] !== cur[k]);
        if (textChanged) {
            const hasCur = db.prepare('SELECT 1 FROM paste_versions WHERE paste_id = ? AND revision = ?').get(id, cur.revision);
            if (!hasCur) {
                db.prepare('INSERT INTO paste_versions (paste_id, revision, title, content, language, edited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                    .run(id, cur.revision, cur.title, cur.content, cur.language, cur.owner_subject, cur.updated_at || cur.created_at);
            }
            sets.push('revision = revision + 1');
        }
        sets.push('updated_at = CURRENT_TIMESTAMP');
        db.prepare(`UPDATE pastes SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
        const next = getById(db, id);
        if (textChanged) {
            db.prepare('INSERT INTO paste_versions (paste_id, revision, title, content, language, edited_by) VALUES (?, ?, ?, ?, ?, ?)')
                .run(id, next.revision, next.title, next.content, next.language, editedBy);
        }
        const changed = ['title', 'content', 'language', 'visibility', 'is_nsfw', 'pinned'].filter((k) => patch[k] !== undefined && patch[k] !== cur[k]);
        if (changed.length) require('../events').pasteUpdated(next, changed);
        return next;
    })();
}

function listVersions(db, pasteId) {
    return db.prepare('SELECT revision, title, content, language, edited_by, created_at FROM paste_versions WHERE paste_id = ? ORDER BY revision ASC').all(pasteId);
}

/** Soft delete: the row stays (slug + legacy id reserved), its content and image link do not. */
function softDelete(db, id) {
    return db.transaction(() => {
        const cur = getById(db, id);
        const n = db.prepare(`UPDATE pastes SET deleted_at = CURRENT_TIMESTAMP, content = NULL, screenshot_url = NULL, metadata = NULL,
                       ai_summary = NULL, ai_tags = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL`).run(id).changes;
        if (n && cur) require('../events').pasteDeleted(cur.slug);   // community.paste.deleted
        return n;
    })();
}

/**
 * List pastes.
 *   opts.ownerSubject     only this owner's pastes
 *   opts.includeHidden    also unlisted, private and burn-after-read (only ever set for the owner or staff)
 *   opts.type             'paste' | 'screenshot'
 *   opts.search           substring of title or content
 *   opts.origin           'user' | 'ai' (default: all)
 *   opts.needsAi          pastes without an AI summary, any visibility (staff work queue)
 *   opts.sort             'oldest' | 'top' (views, a like worth five) | newest (default)
 *   opts.since            created at or after this 'YYYY-MM-DD HH:MM:SS' (UTC) moment
 *   opts.pinnedFirst      pinned pastes lead the list (default true); feeds that merge this list
 *                         with others by date or score turn it off so the order is the sort alone
 * Returns { rows, total }.
 */
function listPastes(db, opts = {}) {
    const where = ['deleted_at IS NULL'];
    const params = [];
    // The AI work queue spans visibility (Media's rule) and takes rows nothing has annotated yet.
    if (opts.needsAi) where.push("COALESCE(ai_summary, '') = '' AND ai_analyzed_at IS NULL");
    // Burn-after-read pastes are link-only: listing them (with a content preview, or as a search
    // hit) would give their content away without the read that burns them.
    else if (!opts.includeHidden) where.push("visibility = 'public' AND burn_after_read = 0");
    if (opts.origin === 'user' || opts.origin === 'ai' || opts.origin === 'imported') { where.push('origin = ?'); params.push(opts.origin); }
    if (opts.ownerSubject !== undefined) { where.push('owner_subject = ?'); params.push(opts.ownerSubject); }
    if (opts.type === 'paste' || opts.type === 'screenshot') { where.push('type = ?'); params.push(opts.type); }
    if (opts.search) {
        const q = `%${likeEscape(opts.search)}%`;
        where.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
        params.push(q, q);
    }
    // datetime() on both sides: imported rows may carry ISO text, which must compare by time.
    if (opts.since) { where.push('datetime(created_at) >= datetime(?)'); params.push(opts.since); }
    const dir = opts.sort === 'oldest' ? 'ASC' : 'DESC';
    const pinned = opts.pinnedFirst === false ? '' : 'pinned DESC, ';
    const order = opts.sort === 'top'
        ? `${pinned}(views + 5 * likes) DESC, created_at DESC, id DESC`
        : `${pinned}created_at ${dir}, id ${dir}`;
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
    const clause = where.join(' AND ');
    const rows = db.prepare(`SELECT * FROM pastes WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset);
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM pastes WHERE ${clause}`).get(...params);
    return { rows, total };
}

/** Pastes created by a subject since `sinceSql` (an SQLite datetime modifier, e.g. '-1 day'). */
function countOwnerSince(db, subject, sinceSql) {
    return db.prepare("SELECT COUNT(*) AS c FROM pastes WHERE owner_subject = ? AND created_at > datetime('now', ?)").get(subject, sinceSql).c;
}

/** ms timestamp of the subject's newest paste (deleted ones count: deleting doesn't reset a cooldown). */
function lastPasteTime(db, subject) {
    const row = db.prepare('SELECT created_at FROM pastes WHERE owner_subject = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(subject);
    return row ? Date.parse(String(row.created_at).replace(' ', 'T') + 'Z') : 0;
}

function hasLiked(db, pasteId, subject) {
    return !!db.prepare('SELECT 1 FROM paste_likes WHERE paste_id = ? AND subject_id = ?').get(pasteId, subject);
}

/** Toggle a like; the counter is recounted from the rows (as Media did). → { liked, likes } */
function toggleLike(db, pasteId, subject) {
    return db.transaction(() => {
        const already = hasLiked(db, pasteId, subject);
        if (already) db.prepare('DELETE FROM paste_likes WHERE paste_id = ? AND subject_id = ?').run(pasteId, subject);
        else db.prepare('INSERT OR IGNORE INTO paste_likes (paste_id, subject_id) VALUES (?, ?)').run(pasteId, subject);
        db.prepare('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?').run(pasteId, pasteId);
        return { liked: !already, likes: db.prepare('SELECT likes FROM pastes WHERE id = ?').get(pasteId).likes };
    })();
}

function incrementCopies(db, pasteId) {
    db.prepare('UPDATE pastes SET copies = copies + 1 WHERE id = ?').run(pasteId);
    return db.prepare('SELECT copies FROM pastes WHERE id = ?').get(pasteId).copies;
}

/** Burn-after-read pastes keep a literal every-read counter. Returns the new count. */
function bumpViews(db, pasteId) {
    db.prepare('UPDATE pastes SET views = views + 1 WHERE id = ?').run(pasteId);
    return db.prepare('SELECT views FROM pastes WHERE id = ?').get(pasteId).views;
}

/**
 * Visit-based view counting (Media's rules): a visitor's first visit counts as a view and a
 * unique view; later visits count again only after `cooldownSec`. → { counted, unique, views, unique_views }
 */
function recordVisit(db, pasteId, visitor, cooldownSec) {
    return db.transaction(() => {
        const row = db.prepare('SELECT last_at FROM paste_visits WHERE paste_id = ? AND visitor = ?').get(pasteId, visitor);
        let counted = false, unique = false;
        if (!row) {
            db.prepare('INSERT INTO paste_visits (paste_id, visitor) VALUES (?, ?)').run(pasteId, visitor);
            db.prepare('UPDATE pastes SET views = views + 1, unique_views = unique_views + 1 WHERE id = ?').run(pasteId);
            counted = true; unique = true;
        } else {
            const lastMs = Date.parse(String(row.last_at).replace(' ', 'T') + 'Z');
            if (!(cooldownSec > 0 && Date.now() - lastMs < cooldownSec * 1000)) {
                db.prepare('UPDATE paste_visits SET last_at = CURRENT_TIMESTAMP, visits = visits + 1 WHERE paste_id = ? AND visitor = ?').run(pasteId, visitor);
                db.prepare('UPDATE pastes SET views = views + 1 WHERE id = ?').run(pasteId);
                counted = true;
            }
        }
        const c = db.prepare('SELECT views, unique_views FROM pastes WHERE id = ?').get(pasteId);
        return { counted, unique, views: c.views, unique_views: c.unique_views };
    })();
}

function pruneVisits(db, days = 30) {
    return db.prepare("DELETE FROM paste_visits WHERE last_at < datetime('now', ?)").run(`-${days} days`).changes;
}

function setAi(db, pasteId, summary, tags) {
    db.prepare('UPDATE pastes SET ai_summary = ?, ai_tags = ?, ai_analyzed_at = CURRENT_TIMESTAMP WHERE id = ?').run(summary, tags, pasteId);
    return getById(db, pasteId);
}

function setScreenshot(db, pasteId, url, mediaRef) {
    db.prepare('UPDATE pastes SET screenshot_url = ?, media_ref = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(url, mediaRef, pasteId);
    return getById(db, pasteId);
}

function setVisibility(db, pasteId, visibility) {
    return db.transaction(() => {
        const cur = getById(db, pasteId);
        const r = db.prepare('UPDATE pastes SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run(visibility, pasteId);
        if (r.changes && cur && cur.visibility !== visibility) require('../events').pasteUpdated(getById(db, pasteId), ['visibility']);
        return r.changes;
    })();
}

/** Media's admin stats shape. */
function stats(db) {
    const r = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN type = 'paste' THEN 1 ELSE 0 END) AS textPastes,
               SUM(CASE WHEN type = 'screenshot' THEN 1 ELSE 0 END) AS screenshots,
               SUM(CASE WHEN forked_from IS NOT NULL THEN 1 ELSE 0 END) AS forks,
               COALESCE(SUM(views), 0) AS totalViews,
               COALESCE(SUM(copies), 0) AS totalCopies,
               COALESCE(SUM(likes), 0) AS totalLikes
        FROM pastes WHERE deleted_at IS NULL`).get() || {};
    return {
        total: r.total || 0, textPastes: r.textPastes || 0, screenshots: r.screenshots || 0, forks: r.forks || 0,
        totalViews: r.totalViews || 0, totalCopies: r.totalCopies || 0, totalLikes: r.totalLikes || 0,
    };
}

function listForks(db, limit, offset) {
    const forks = db.prepare(`SELECT id, slug, owner_subject, type, title, forked_from, visibility, views, copies, likes, created_at
                              FROM pastes WHERE forked_from IS NOT NULL AND deleted_at IS NULL
                              ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS c FROM pastes WHERE forked_from IS NOT NULL AND deleted_at IS NULL').get().c;
    return { forks, total };
}

function deleteAllForks(db) {
    return db.transaction(() => {
        const ids = db.prepare('SELECT id FROM pastes WHERE forked_from IS NOT NULL AND deleted_at IS NULL').all().map((r) => r.id);
        for (const id of ids) softDelete(db, id);
        return ids.length;
    })();
}

// ── Comments ─────────────────────────────────────────────────

function createComment(db, { paste_id, author_subject, anon_name, parent_id, message }) {
    const info = db.prepare('INSERT INTO paste_comments (paste_id, author_subject, anon_name, parent_id, message) VALUES (?, ?, ?, ?, ?)')
        .run(paste_id, author_subject || null, anon_name || null, parent_id || null, message);
    return getComment(db, info.lastInsertRowid);
}

function getComment(db, id) {
    return db.prepare('SELECT * FROM paste_comments WHERE id = ?').get(id) || null;
}

/** Top-level comments (newest first) with their replies (oldest first); deleted ones hidden. */
function listComments(db, pasteId, limit = 50, offset = 0) {
    const top = db.prepare(`SELECT * FROM paste_comments WHERE paste_id = ? AND is_deleted = 0 AND parent_id IS NULL
                            ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(pasteId, limit, offset);
    const replies = db.prepare('SELECT * FROM paste_comments WHERE parent_id = ? AND is_deleted = 0 ORDER BY created_at ASC, id ASC');
    for (const c of top) { c.replies = replies.all(c.id); c.reply_count = c.replies.length; }
    return top;
}

function countComments(db, pasteId) {
    return db.prepare('SELECT COUNT(*) AS c FROM paste_comments WHERE paste_id = ? AND is_deleted = 0').get(pasteId).c;
}

function softDeleteComment(db, id) {
    return db.prepare('UPDATE paste_comments SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id).changes;
}

// ── Subject projection (display cache — never authority) ─────

function getProjections(db, subjectIds) {
    const out = new Map();
    const ids = [...new Set((subjectIds || []).filter(Boolean))];
    const stmt = db.prepare('SELECT * FROM subject_projection WHERE subject_id = ?');
    for (const id of ids) { const r = stmt.get(id); if (r) out.set(id, r); }
    return out;
}

/** Upsert what we were told about a subject. Fields left undefined keep their stored value. */
function upsertProjection(db, p) {
    if (!p || !p.subject_id) return;
    db.prepare(`INSERT INTO subject_projection (subject_id, username, display_name, avatar_url, profile_color, refreshed_at)
                VALUES (@subject_id, @username, @display_name, @avatar_url, @profile_color, CURRENT_TIMESTAMP)
                ON CONFLICT(subject_id) DO UPDATE SET
                    username = COALESCE(excluded.username, username),
                    display_name = COALESCE(excluded.display_name, display_name),
                    avatar_url = COALESCE(excluded.avatar_url, avatar_url),
                    profile_color = COALESCE(excluded.profile_color, profile_color),
                    refreshed_at = CURRENT_TIMESTAMP`)
        .run({
            subject_id: p.subject_id, username: p.username ?? null, display_name: p.display_name ?? null,
            avatar_url: p.avatar_url ?? null, profile_color: p.profile_color ?? null,
        });
}

/** Subjects whose cached username matches (case-insensitive), most recently refreshed first. */
function subjectsByUsername(db, username) {
    return db.prepare('SELECT subject_id FROM subject_projection WHERE username = ? COLLATE NOCASE ORDER BY refreshed_at DESC')
        .all(String(username)).map((r) => r.subject_id);
}

// ── Legacy id map ────────────────────────────────────────────

function mapGet(db, system, type, id) {
    return db.prepare('SELECT target_type, target_id FROM legacy_id_map WHERE source_system = ? AND source_type = ? AND source_id = ?')
        .get(String(system), String(type), String(id)) || null;
}

function mapSet(db, system, type, id, targetType, targetId) {
    db.prepare(`INSERT INTO legacy_id_map (source_system, source_type, source_id, target_type, target_id) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(source_system, source_type, source_id) DO UPDATE SET target_type = excluded.target_type, target_id = excluded.target_id`)
        .run(String(system), String(type), String(id), String(targetType), String(targetId));
}

module.exports = {
    generateSlug, sanitizeTitle, detectLanguage,
    getBySlug, getById, insertPaste, updatePaste, listVersions, softDelete, listPastes,
    countOwnerSince, lastPasteTime, hasLiked, toggleLike, incrementCopies, bumpViews, recordVisit, pruneVisits,
    setAi, setScreenshot, setVisibility, stats, listForks, deleteAllForks,
    createComment, getComment, listComments, countComments, softDeleteComment,
    getProjections, upsertProjection, subjectsByUsername,
    mapGet, mapSet,
    SLUG_ADJECTIVES, SLUG_NOUNS,
};
