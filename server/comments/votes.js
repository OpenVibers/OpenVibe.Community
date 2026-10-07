'use strict';

/**
 * Up/down votes on comments — one row per (target, person), value 1 or -1.
 *
 * Race safety: a vote is a single UPSERT (or DELETE for 0) followed, in the same transaction, by
 * recomputing the target's score from the vote rows. The score is never incremented or decremented,
 * so interleaved votes from any number of connections or processes cannot drift it. The transaction
 * first locks the target row (SELECT … FOR UPDATE), so votes on one target queue and each recount
 * sees every vote committed before it.
 */
/** value 1 | -1 | 0 (0 removes the vote). → { score, upvotes, downvotes, my_vote } */
async function applyVote(db, targetId, subject, value) {
    if (![1, -1, 0].includes(value)) throw new Error('vote value must be 1, -1 or 0');
    return await db.tx(async () => {
        await db.prepare('SELECT id FROM comments WHERE id = ? FOR UPDATE').get(targetId);
        if (value === 0) {
            await db.prepare('DELETE FROM comment_votes WHERE comment_id = ? AND subject_id = ?').run(targetId, subject);
        } else {
            await db.prepare(`INSERT INTO comment_votes (comment_id, subject_id, value) VALUES (?, ?, ?)
                        ON CONFLICT(comment_id, subject_id) DO UPDATE SET value = excluded.value, updated_at = ov_now()`)
                .run(targetId, subject, value);
        }
        const agg = await db.prepare(`SELECT COALESCE(SUM(value), 0)::bigint AS score,
                                       COUNT(*) FILTER (WHERE value = 1) AS upvotes,
                                       COUNT(*) FILTER (WHERE value = -1) AS downvotes
                                FROM comment_votes WHERE comment_id = ?`).get(targetId);
        await db.prepare('UPDATE comments SET score = ?, upvotes = ?, downvotes = ? WHERE id = ?').run(agg.score, agg.upvotes, agg.downvotes, targetId);
        return { score: agg.score, upvotes: agg.upvotes, downvotes: agg.downvotes, my_vote: value };
    });
}

/** The person's current votes on some targets. → Map id → 1|-1 */
async function myVotes(db, targetIds, subject) {
    const out = new Map();
    if (!subject || !targetIds.length) return out;
    const rows = await db.prepare('SELECT comment_id AS id, value FROM comment_votes WHERE comment_id = ANY(?::bigint[]) AND subject_id = ?').all([...new Set(targetIds)], subject);
    for (const r of rows) out.set(r.id, r.value);
    return out;
}

/** Parse a request's vote value: 1, -1 or 0 (numbers or numeric strings), else null. */
function parseVote(v) {
    const n = typeof v === 'string' && /^-?[01]$/.test(v.trim()) ? Number(v) : v;
    return n === 1 || n === -1 || n === 0 ? n : null;
}

module.exports = { applyVote, myVotes, parseVote };
