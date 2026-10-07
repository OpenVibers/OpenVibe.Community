'use strict';
/** Repoint a merged Network subject in Community's pastes, comments, Pulse and submissions. */
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MERGE_RE = /^mrg_[0-9A-HJKMNP-TV-Z]{26}$/;

const AUTHORSHIP = [
    ['pastes', 'owner_subject'], ['paste_comments', 'author_subject'], ['comments', 'author_subject'],
    ['pulse_items', 'actor_subject'],
    ['submissions', 'author_subject'], ['submissions', 'reviewer_subject'],
];
// Per person per item: [table, item column, recompute(db, itemId)]
const PER_ITEM = [
    ['paste_likes', 'paste_id', async (db, id) => await db.prepare('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?').run(id, id)],
    ['comment_votes', 'comment_id', async (db, id) => {
        const a = await db.prepare('SELECT COALESCE(SUM(value), 0)::bigint AS s, COUNT(*) FILTER (WHERE value = 1) AS u, COUNT(*) FILTER (WHERE value = -1) AS d FROM comment_votes WHERE comment_id = ?').get(id);
        await db.prepare('UPDATE comments SET score = ?, upvotes = ?, downvotes = ? WHERE id = ?').run(a.s, a.u, a.d, id);
    }],
];

const hasColumn = async (db, table, col) => !!await db.prepare('SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?').get(table, col);

/** The payload, or 'ignored:<why>'. */
function payloadOf(event) {
    if (!event || event.event_type !== 'network.subject.merged') return 'ignored:type';
    if (event.source !== 'network') return 'ignored:source';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (!MERGE_RE.test(String(p.merge_id || '')) || !SUBJECT_RE.test(String(p.from || '')) || !SUBJECT_RE.test(String(p.into || '')) || p.from === p.into) return 'ignored:payload';
    return { merge_id: p.merge_id, from: p.from, into: p.into };
}

/** Apply one merge → 'merge:applied' (with counts logged). */
async function apply(db, { from, into, merge_id: mergeId }, { log = console } = {}) {
    const counts = await db.tx(async () => {
        const c = { authored: 0, moved: 0, dropped: 0 };
        for (const [table, col] of AUTHORSHIP) {
            if (await hasColumn(db, table, col)) c.authored += (await db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(into, from)).changes;
        }
        for (const [table, item, recompute] of PER_ITEM) {
            if (!await hasColumn(db, table, 'subject_id')) continue;
            for (const r of await db.prepare(`SELECT ${item} AS i FROM ${table} WHERE subject_id = ?`).all(from)) {
                const clash = await db.prepare(`SELECT 1 FROM ${table} WHERE ${item} = ? AND subject_id = ?`).get(r.i, into);
                if (clash) { await db.prepare(`DELETE FROM ${table} WHERE ${item} = ? AND subject_id = ?`).run(r.i, from); c.dropped++; if (recompute) await recompute(db, r.i); }
                else { await db.prepare(`UPDATE ${table} SET subject_id = ? WHERE ${item} = ? AND subject_id = ?`).run(into, r.i, from); c.moved++; }
            }
        }
        if (await hasColumn(db, 'game_progress', 'subject_id')) {
            if (await db.prepare('SELECT 1 FROM game_progress WHERE subject_id = ?').get(into)) await db.prepare('DELETE FROM game_progress WHERE subject_id = ?').run(from);
            else await db.prepare('UPDATE game_progress SET subject_id = ? WHERE subject_id = ?').run(into, from);
        }
        if (await hasColumn(db, 'network_blocks', 'blocker_subject')) {
            for (const [col, other] of [['blocker_subject', 'blocked_subject'], ['blocked_subject', 'blocker_subject']]) {
                for (const b of await db.prepare(`SELECT ${other} AS o FROM network_blocks WHERE ${col} = ?`).all(from)) {
                    const clash = b.o === into || await db.prepare(`SELECT 1 FROM network_blocks WHERE ${col} = ? AND ${other} = ?`).get(into, b.o);
                    if (clash) await db.prepare(`DELETE FROM network_blocks WHERE ${col} = ? AND ${other} = ?`).run(from, b.o);
                    else await db.prepare(`UPDATE network_blocks SET ${col} = ? WHERE ${col} = ? AND ${other} = ?`).run(into, from, b.o);
                }
            }
        }
        return c;
    });
    log.log(`[Merge] ${mergeId}: ${JSON.stringify(counts)}`);
    return 'merge:applied';
}

module.exports = { payloadOf, apply };
