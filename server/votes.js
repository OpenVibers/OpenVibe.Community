'use strict';

/**
 * Up/down votes on comments and forum threads — one row per (target, person), value 1 or -1.
 *
 * Race safety: a vote is a single UPSERT (or DELETE for 0) followed, in the same IMMEDIATE
 * transaction, by recomputing the target's score from the vote rows. The score is never
 * incremented or decremented, so interleaved votes from any number of connections or processes
 * cannot drift it: whatever order the writes land in, the stored score is the sum of the rows
 * that exist when the last transaction commits. IMMEDIATE takes SQLite's write lock up front
 * (instead of upgrading a read lock), so two writers queue on busy_timeout rather than failing.
 */
const TARGETS = {
    comment: { votes: 'comment_votes', key: 'comment_id', table: 'comments', counts: true },
    thread: { votes: 'thread_votes', key: 'thread_id', table: 'threads', counts: false },
};

/** value 1 | -1 | 0 (0 removes the vote). → { score, upvotes, downvotes, my_vote } */
function applyVote(db, kind, targetId, subject, value) {
    const t = TARGETS[kind];
    if (!t) throw new Error(`unknown vote target ${kind}`);
    if (![1, -1, 0].includes(value)) throw new Error('vote value must be 1, -1 or 0');
    return db.transaction(() => {
        if (value === 0) {
            db.prepare(`DELETE FROM ${t.votes} WHERE ${t.key} = ? AND subject_id = ?`).run(targetId, subject);
        } else {
            db.prepare(`INSERT INTO ${t.votes} (${t.key}, subject_id, value) VALUES (?, ?, ?)
                        ON CONFLICT(${t.key}, subject_id) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
                .run(targetId, subject, value);
        }
        const agg = db.prepare(`SELECT COALESCE(SUM(value), 0) AS score,
                                       COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
                                       COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0) AS downvotes
                                FROM ${t.votes} WHERE ${t.key} = ?`).get(targetId);
        if (t.counts) db.prepare(`UPDATE ${t.table} SET score = ?, upvotes = ?, downvotes = ? WHERE id = ?`).run(agg.score, agg.upvotes, agg.downvotes, targetId);
        else db.prepare(`UPDATE ${t.table} SET score = ? WHERE id = ?`).run(agg.score, targetId);
        return { score: agg.score, upvotes: agg.upvotes, downvotes: agg.downvotes, my_vote: value };
    }).immediate();
}

/** The person's current votes on some targets. → Map id → 1|-1 */
function myVotes(db, kind, targetIds, subject) {
    const t = TARGETS[kind];
    const out = new Map();
    if (!subject || !targetIds.length) return out;
    const stmt = db.prepare(`SELECT value FROM ${t.votes} WHERE ${t.key} = ? AND subject_id = ?`);
    for (const id of new Set(targetIds)) { const r = stmt.get(id, subject); if (r) out.set(id, r.value); }
    return out;
}

/** Parse a request's vote value: 1, -1 or 0 (numbers or numeric strings), else null. */
function parseVote(v) {
    const n = typeof v === 'string' && /^-?[01]$/.test(v.trim()) ? Number(v) : v;
    return n === 1 || n === -1 || n === 0 ? n : null;
}

module.exports = { applyVote, myVotes, parseVote };
