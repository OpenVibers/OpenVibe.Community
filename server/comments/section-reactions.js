'use strict';

/**
 * Section reactions: a reader says whether a SECTION of a post was good (👍 or 👎).
 *
 * One thread per post (comment_threads), so the section id is the key: a row is
 * (thread, section, person, value). The same person reacting again replaces their row; reacting
 * with 0 takes it back. The counts are recomputed from the rows, never incremented, so they cannot
 * drift (the same rule the comment votes follow, server/votes.js).
 *
 * Nothing here decides who may react: service.js does that.
 */

/** A person's reaction to a section (1, -1 or 0 to take it back). → { section_id, value, upvotes, downvotes } */
async function setSectionReaction(db, threadId, sectionId, subject, value) {
    if (![1, -1, 0].includes(value)) throw new Error('value must be 1, -1 or 0');
    return await db.tx(async () => {
        await db.prepare('SELECT id FROM comment_threads WHERE id = ? FOR UPDATE').get(threadId);
        if (value === 0) {
            await db.prepare('DELETE FROM thread_section_reactions WHERE thread_id = ? AND section_id = ? AND subject_id = ?')
                .run(threadId, sectionId, subject);
        } else {
            await db.prepare(`INSERT INTO thread_section_reactions (thread_id, section_id, subject_id, value) VALUES (?, ?, ?, ?)
                        ON CONFLICT (thread_id, section_id, subject_id) DO UPDATE SET value = excluded.value, updated_at = now()`)
                .run(threadId, sectionId, subject, value);
        }
        const agg = await db.prepare(`SELECT COUNT(*) FILTER (WHERE value = 1) AS upvotes,
                                       COUNT(*) FILTER (WHERE value = -1) AS downvotes
                                FROM thread_section_reactions WHERE thread_id = ? AND section_id = ?`)
            .get(threadId, sectionId);
        return {
            section_id: sectionId,
            value,
            upvotes: Number(agg.upvotes) || 0,
            downvotes: Number(agg.downvotes) || 0,
        };
    });
}

/** The counts of every section of a thread. → Map sectionId → { up, down } */
async function sectionReactions(db, threadId) {
    const rows = await db.prepare(`SELECT section_id,
                                       COUNT(*) FILTER (WHERE value = 1) AS up,
                                       COUNT(*) FILTER (WHERE value = -1) AS down
                                FROM thread_section_reactions WHERE thread_id = ?
                                GROUP BY section_id`).all(threadId);
    const out = new Map();
    for (const r of rows) out.set(r.section_id, { up: Number(r.up) || 0, down: Number(r.down) || 0 });
    return out;
}

/** What one person said about each section. → Map sectionId → 1 | -1 */
async function mySectionReactions(db, threadId, subject) {
    const out = new Map();
    if (!subject) return out;
    const rows = await db.prepare('SELECT section_id, value FROM thread_section_reactions WHERE thread_id = ? AND subject_id = ?')
        .all(threadId, subject);
    for (const r of rows) out.set(r.section_id, r.value);
    return out;
}

module.exports = { setSectionReaction, sectionReactions, mySectionReactions };
