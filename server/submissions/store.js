'use strict';

/**
 * Submissions store — pure SQL over submissions (migrations/0003_submissions.sql).
 */
const crypto = require('crypto');
const { SLUG_ADJECTIVES, SLUG_NOUNS } = require('../pastes/store');

/** adj-noun-NNNN, like a public paste's slug with a wider number; unique in submissions. */
async function generateSlug(db) {
    const taken = db.prepare('SELECT 1 FROM submissions WHERE slug = ?');
    for (let i = 0; i < 20; i++) {
        const slug = `${SLUG_ADJECTIVES[crypto.randomInt(SLUG_ADJECTIVES.length)]}-${SLUG_NOUNS[crypto.randomInt(SLUG_NOUNS.length)]}-${crypto.randomInt(100, i < 10 ? 10000 : 1000000)}`;
        if (!await taken.get(slug)) return slug;
    }
    throw new Error('Could not generate a unique submission slug');
}

async function getBySlug(db, slug) {
    return await db.prepare('SELECT * FROM submissions WHERE slug = ?').get(String(slug));
}

async function insert(db, s) {
    const info = await db.prepare(`INSERT INTO submissions (slug, kind, title, body, url, media_ref, author_subject)
                                   VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(s.slug, s.kind, s.title, s.body, s.url, s.media_ref, s.author_subject);
    return await db.prepare('SELECT * FROM submissions WHERE id = ?').get(info.lastInsertRowid);
}

/** Move a submission on, only from one of the statuses in `from` (a race loses cleanly). → the row, or null */
async function setStatus(db, id, { status, from, reviewer_subject, review_note, reviewed }) {
    const sets = ['status = ?', 'updated_at = ov_now()'];
    const params = [status];
    if (reviewed) { sets.push('reviewer_subject = ?', 'review_note = ?', 'reviewed_at = ov_now()'); params.push(reviewer_subject || null, review_note || null); }
    const r = await db.prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ? AND status IN (${from.map(() => '?').join(',')})`).run(...params, id, ...from);
    return r.changes ? await db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) : null;
}

/** How many a person sent since a time (the daily cap). */
async function countByAuthorSince(db, subject, since) {
    return Number((await db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE author_subject = ? AND created_at >= ?').get(subject, since)).n);
}

/**
 * Newest first, keyset-paginated by (created_at, id).
 *   opts.status   one status, or null for any
 *   opts.author   only this person's
 *   opts.kind     one kind, or null
 *   opts.before   [created_at, id] of the last row already seen
 * → { rows, hasMore }
 */
async function list(db, { status = null, author = null, kind = null, before = null, limit = 30 } = {}) {
    const rows = await db.prepare(`
        SELECT * FROM submissions
        WHERE (@status::text IS NULL OR status = @status)
          AND (@author::text IS NULL OR author_subject = @author)
          AND (@kind::text IS NULL OR kind = @kind)
          AND (@at::text IS NULL OR created_at < @at OR (created_at = @at AND id < @id::bigint))
        ORDER BY created_at DESC, id DESC
        LIMIT @limit`).all({ status, author, kind, at: before ? before[0] : null, id: before ? before[1] : null, limit: limit + 1 });
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

module.exports = { generateSlug, getBySlug, insert, setStatus, countByAuthorSince, list };
