'use strict';

/**
 * Ratings on forum posts, after Facepunch: instead of a plain like, a row of specific community judgments.
 * One rating per person per post (rating again with the same one takes it back; another replaces it);
 * nobody rates their own post. A space can switch ratings off (spaces.reactions).
 */
const REACTIONS = Object.freeze([
    { key: 'agree', emoji: '✅', label: 'Agree', group: 'positive' },
    { key: 'winner', emoji: '🏆', label: 'Winner', group: 'positive' },
    { key: 'funny', emoji: '😂', label: 'Funny', group: 'positive' },
    { key: 'informative', emoji: '💡', label: 'Informative', group: 'positive' },
    { key: 'friendly', emoji: '😊', label: 'Friendly', group: 'positive' },
    { key: 'sympathy', emoji: '❤️', label: 'Sympathy', group: 'positive' },
    { key: 'dumb', emoji: '📦', label: 'Dumb', group: 'negative' },
    { key: 'disgusting', emoji: '🤢', label: 'Disgusting', group: 'negative' },
    { key: 'bad_reading', emoji: '📖', label: 'Bad reading', group: 'utility' },
    { key: 'late', emoji: '🕒', label: 'Late', group: 'utility' },
]);
const BY_KEY = new Map(REACTIONS.map((r) => [r.key, r]));
const ORDER = new Map(REACTIONS.map((r, i) => [r.key, i]));

/** Set (or with null, remove) a person's rating of a post. → the rating now held, or null */
function setReaction(db, postId, subject, reaction) {
    const cur = db.prepare('SELECT reaction FROM post_reactions WHERE post_id = ? AND subject_id = ?').get(postId, subject);
    if (!reaction || (cur && cur.reaction === reaction)) {
        db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND subject_id = ?').run(postId, subject);
        return null;
    }
    db.prepare(`INSERT INTO post_reactions (post_id, subject_id, reaction) VALUES (?, ?, ?)
                ON CONFLICT (post_id, subject_id) DO UPDATE SET reaction = excluded.reaction, created_at = CURRENT_TIMESTAMP`).run(postId, subject, reaction);
    return reaction;
}

const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

/**
 * Ratings of these posts. → Map postId → [{ key, emoji, label, group, count, raters: [subject…] (first 8), mine }]
 * in the fixed order, only ratings someone gave.
 */
function reactionsFor(db, postIds, viewerSubject = null) {
    const out = new Map();
    if (!postIds.length) return out;
    const rows = db.prepare(`SELECT post_id, reaction, subject_id FROM post_reactions WHERE post_id IN (${placeholders(postIds.length)}) ORDER BY created_at, subject_id`).all(...postIds);
    for (const r of rows) {
        const def = BY_KEY.get(r.reaction);
        if (!def) continue;
        if (!out.has(r.post_id)) out.set(r.post_id, new Map());
        const m = out.get(r.post_id);
        if (!m.has(r.reaction)) m.set(r.reaction, { ...def, count: 0, raters: [], mine: false });
        const e = m.get(r.reaction);
        e.count++;
        if (e.raters.length < 8) e.raters.push(r.subject_id);
        if (viewerSubject && r.subject_id === viewerSubject) e.mine = true;
    }
    return new Map([...out].map(([id, m]) => [id, [...m.values()].sort((a, b) => ORDER.get(a.key) - ORDER.get(b.key))]));
}

/** The ratings each author has received, most given first (top 3). → Map subject → [{ key, emoji, label, count }] */
function receivedBy(db, subjects) {
    const out = new Map();
    const list = [...new Set(subjects.filter(Boolean))];
    if (!list.length) return out;
    const rows = db.prepare(`SELECT p.author_subject AS s, r.reaction, COUNT(*) AS n FROM post_reactions r JOIN posts p ON p.id = r.post_id
                             WHERE p.author_subject IN (${placeholders(list.length)}) AND p.deleted_at IS NULL GROUP BY p.author_subject, r.reaction`).all(...list);
    for (const r of rows) {
        const def = BY_KEY.get(r.reaction);
        if (!def) continue;
        if (!out.has(r.s)) out.set(r.s, []);
        out.get(r.s).push({ key: def.key, emoji: def.emoji, label: def.label, count: r.n });
    }
    for (const [s, l] of out) out.set(s, l.sort((a, b) => b.count - a.count || ORDER.get(a.key) - ORDER.get(b.key)).slice(0, 3));
    return out;
}

module.exports = { REACTIONS, BY_KEY, setReaction, reactionsFor, receivedBy };
