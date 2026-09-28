'use strict';
/**
 * Vote races. A vote is one UPSERT plus a score recomputed from the rows in the same transaction, after locking
 * the target row (server/votes.js), so however writes interleave the stored score is the sum of the vote rows.
 * Checked on a real database: interleaved writes step by step, a stale reader, then 1000 votes with 32 in flight at a
 * time (under npm run test:pg they run on separate PostgreSQL connections through PgBouncer).
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { testDb } = require('./helpers/db');
const { applyVote } = require('../server/votes');
const commentStore = require('../server/comments/store');
const forumStore = require('../server/forum/store');
const { check, done } = require('./helpers/app');

let db, comment, thread, subjects;

async function invariant(label) {
    const c = await db.prepare('SELECT score, upvotes, downvotes FROM comments WHERE id = ?').get(comment.id);
    const cv = await db.prepare(`SELECT COALESCE(SUM(value), 0)::bigint AS s, COUNT(*) FILTER (WHERE value = 1) AS up, COUNT(*) FILTER (WHERE value = -1) AS down
                                 FROM comment_votes WHERE comment_id = ?`).get(comment.id);
    assert.deepStrictEqual([c.score, c.upvotes, c.downvotes], [cv.s, cv.up, cv.down], `${label}: comment score is the sum of its votes`);
    const t = await db.prepare('SELECT score FROM threads WHERE id = ?').get(thread.id);
    const tv = await db.prepare('SELECT COALESCE(SUM(value), 0)::bigint AS s FROM thread_votes WHERE thread_id = ?').get(thread.id);
    assert.strictEqual(t.score, tv.s, `${label}: thread score is the sum of its votes`);
    const dup = (await db.prepare('SELECT COUNT(*) AS n FROM (SELECT subject_id FROM comment_votes WHERE comment_id = ? GROUP BY subject_id HAVING COUNT(*) > 1) d').get(comment.id)).n;
    assert.strictEqual(dup, 0, `${label}: one vote per person`);
}

(async () => {
    db = await testDb({ max: 8 });
    const { thread: cthread } = await commentStore.resolveThread(db, { service: 'live', type: 'vod', id: 'race' });
    comment = await commentStore.insertComment(db, { thread_id: cthread.id, message: 'vote on me' });
    const space = await forumStore.getSpace(db, 'general');
    ({ thread } = await forumStore.createThread(db, { space_id: space.id, title: 'Race thread', body_markdown: 'go' }));
    subjects = Array.from({ length: 10 }, () => ids.newId('user'));

    await check('interleaved votes: add, flip, remove — the score never drifts', async () => {
        const [s1, s2, s3] = subjects;
        const steps = [[s1, 1], [s1, -1], [s2, 1], [s2, 1], [s1, -1], [s3, -1], [s3, 0], [s1, 1], [s2, 0], [s2, -1], [s3, 1], [s3, 1]];
        for (const [s, v] of steps) {
            const out = await applyVote(db, 'comment', comment.id, s, v);
            await applyVote(db, 'thread', thread.id, s, v);
            await invariant('after step');
            assert.strictEqual(out.my_vote, v);
        }
        // Final state is the last write per person: s1 +1, s2 −1, s3 +1.
        const c = await db.prepare('SELECT score, upvotes, downvotes FROM comments WHERE id = ?').get(comment.id);
        assert.deepStrictEqual({ ...c }, { score: 1, upvotes: 2, downvotes: 1 });
    });

    await check('a stale reader cannot overwrite a newer score: the recount reads the rows under the row lock', async () => {
        const staleScore = (await db.prepare('SELECT score FROM comments WHERE id = ?').get(comment.id)).score;
        await applyVote(db, 'comment', comment.id, subjects[4], 1);
        const out = await applyVote(db, 'comment', comment.id, subjects[5], 1);
        assert.strictEqual(out.score, staleScore + 2);
        await invariant('stale reader');
    });

    await check('1000 votes, 32 in flight at a time, on one comment and one thread: invariants hold, none fails', async () => {
        let seed = 7919;
        const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const ops = Array.from({ length: 1000 }, () => [subjects[rand(subjects.length)], [1, -1, 0][rand(3)], rand(2)]);
        // 32 in flight at a time: more than the pool's connections, so votes queue and interleave on the row locks.
        const failed = [];
        let next = 0;
        await Promise.all(Array.from({ length: 32 }, async () => {
            while (next < ops.length) {
                const [s, v, onComment] = ops[next++];
                try { await (onComment ? await applyVote(db, 'comment', comment.id, s, v) : await applyVote(db, 'thread', thread.id, s, v)); } catch (err) { failed.push(err); }
            }
        }));
        assert.strictEqual(failed.length, 0, failed.length ? failed[0].message : '');
        await invariant('after the storm');
        const rows = (await db.prepare('SELECT COUNT(*) AS n FROM comment_votes WHERE comment_id = ?').get(comment.id)).n;
        assert.ok(rows <= subjects.length);
    });

    await db.close();
    done();
})();
