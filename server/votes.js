'use strict';

/**
 * Up/down votes on comments and forum threads — one row per (target, person), value 1 or -1.
 *
 * Race safety: a vote is a single UPSERT (or DELETE for 0) followed, in the same transaction, by
 * recomputing the target's score from the vote rows. The score is never incremented or decremented,
 * so interleaved votes from any number of connections or processes cannot drift it. The transaction
 * first locks the target row (SELECT … FOR UPDATE, PostgreSQL's stand-in for SQLite's IMMEDIATE), so
 * votes on one target queue and each recount sees every vote committed before it.
 */
const TARGETS = {
    comment: { votes: 'comment_votes', key: 'comment_id', table: 'comments', counts: true },
    thread: { votes: 'thread_votes', key: 'thread_id', table: 'threads', counts: false },
};

/** value 1 | -1 | 0 (0 removes the vote). → { score, upvotes, downvotes, my_vote } */
async function applyVote(db, kind, targetId, subject, value) {
    const t = TARGETS[kind];
    if (!t) throw new Error(`unknown vote target ${kind}`);
    if (![1, -1, 0].includes(value)) throw new Error('vote value must be 1, -1 or 0');
    return await db.tx(async () => {
        await db.prepare(`SELECT id FROM ${t.table} WHERE id = ? FOR UPDATE`).get(targetId);
        if (value === 0) {
            await db.prepare(`DELETE FROM ${t.votes} WHERE ${t.key} = ? AND subject_id = ?`).run(targetId, subject);
        } else {
            await db.prepare(`INSERT INTO ${t.votes} (${t.key}, subject_id, value) VALUES (?, ?, ?)
                        ON CONFLICT(${t.key}, subject_id) DO UPDATE SET value = excluded.value, updated_at = ov_now()`)
                .run(targetId, subject, value);
        }
        const agg = await db.prepare(`SELECT COALESCE(SUM(value), 0)::bigint AS score,
                                       COUNT(*) FILTER (WHERE value = 1) AS upvotes,
                                       COUNT(*) FILTER (WHERE value = -1) AS downvotes
                                FROM ${t.votes} WHERE ${t.key} = ?`).get(targetId);
        if (t.counts) await db.prepare(`UPDATE ${t.table} SET score = ?, upvotes = ?, downvotes = ? WHERE id = ?`).run(agg.score, agg.upvotes, agg.downvotes, targetId);
        else await db.prepare(`UPDATE ${t.table} SET score = ? WHERE id = ?`).run(agg.score, targetId);
        return { score: agg.score, upvotes: agg.upvotes, downvotes: agg.downvotes, my_vote: value };
    });
}

/** The person's current votes on some targets. → Map id → 1|-1 */
async function myVotes(db, kind, targetIds, subject) {
    const t = TARGETS[kind];
    const out = new Map();
    if (!subject || !targetIds.length) return out;
    const rows = await db.prepare(`SELECT ${t.key} AS id, value FROM ${t.votes} WHERE ${t.key} = ANY(?::bigint[]) AND subject_id = ?`).all([...new Set(targetIds)], subject);
    for (const r of rows) out.set(r.id, r.value);
    return out;
}

/** Parse a request's vote value: 1, -1 or 0 (numbers or numeric strings), else null. */
function parseVote(v) {
    const n = typeof v === 'string' && /^-?[01]$/.test(v.trim()) ? Number(v) : v;
    return n === 1 || n === -1 || n === 0 ? n : null;
}

module.exports = { applyVote, myVotes, parseVote };
