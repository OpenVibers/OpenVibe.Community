'use strict';
/**
 * Vote races. A vote is one UPSERT plus a score recomputed from the rows in the same IMMEDIATE
 * transaction (server/votes.js), so however writes interleave the stored score is the sum of the
 * vote rows. Checked two ways against a real database file:
 *   1. two connections in one process, their writes interleaved step by step;
 *   2. four worker threads hammering the same comment and thread at once.
 */
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (!isMainThread) {
    // ── worker: random votes by a small crowd, as fast as it can ──
    const { openDb } = require('../server/db');
    const { applyVote } = require('../server/votes');
    const db = openDb(workerData.file);
    let seed = workerData.seed;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let done = 0;
    try {
        for (let i = 0; i < workerData.ops; i++) {
            const subject = workerData.subjects[rand(workerData.subjects.length)];
            const value = [1, -1, 0][rand(3)];
            if (rand(2)) applyVote(db, 'comment', workerData.commentId, subject, value);
            else applyVote(db, 'thread', workerData.threadId, subject, value);
            done++;
        }
        parentPort.postMessage({ ok: true, done });
    } catch (err) {
        parentPort.postMessage({ ok: false, done, error: err.message });
    } finally { db.close(); }
    return;
}

const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { openDb } = require('../server/db');
const { applyVote } = require('../server/votes');
const commentStore = require('../server/comments/store');
const forumStore = require('../server/forum/store');
const { check, done } = require('./helpers/app');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-votes-'));
const file = path.join(dir, 'votes.db');
const a = openDb(file);
const b = openDb(file);

const { thread: cthread } = commentStore.resolveThread(a, { service: 'live', type: 'vod', id: 'race' });
const comment = commentStore.insertComment(a, { thread_id: cthread.id, message: 'vote on me' });
const space = forumStore.getSpace(a, 'general');
const { thread } = forumStore.createThread(a, { space_id: space.id, title: 'Race thread', body_markdown: 'go' });
const subjects = Array.from({ length: 10 }, () => ids.newId('user'));

function invariant(db, label) {
    const c = db.prepare('SELECT score, upvotes, downvotes FROM comments WHERE id = ?').get(comment.id);
    const cv = db.prepare(`SELECT COALESCE(SUM(value), 0) AS s, COALESCE(SUM(value = 1), 0) AS up, COALESCE(SUM(value = -1), 0) AS down FROM comment_votes WHERE comment_id = ?`).get(comment.id);
    assert.deepStrictEqual([c.score, c.upvotes, c.downvotes], [cv.s, cv.up, cv.down], `${label}: comment score is the sum of its votes`);
    const t = db.prepare('SELECT score FROM threads WHERE id = ?').get(thread.id);
    const tv = db.prepare('SELECT COALESCE(SUM(value), 0) AS s FROM thread_votes WHERE thread_id = ?').get(thread.id);
    assert.strictEqual(t.score, tv.s, `${label}: thread score is the sum of its votes`);
    const dup = db.prepare('SELECT COUNT(*) AS n FROM (SELECT subject_id FROM comment_votes WHERE comment_id = ? GROUP BY subject_id HAVING COUNT(*) > 1)').get(comment.id).n;
    assert.strictEqual(dup, 0, `${label}: one vote per person`);
}

(async () => {
    await check('interleaved UPSERTs on two connections: add, flip, remove — the score never drifts', () => {
        const [s1, s2, s3] = subjects;
        const steps = [
            [a, s1, 1], [b, s1, -1], [a, s2, 1], [b, s2, 1], [a, s1, -1], [b, s3, -1],
            [a, s3, 0], [b, s1, 1], [a, s2, 0], [b, s2, -1], [a, s3, 1], [b, s3, 1],
        ];
        for (const [db, s, v] of steps) {
            const out = applyVote(db, 'comment', comment.id, s, v);
            applyVote(db === a ? b : a, 'thread', thread.id, s, v);
            invariant(a, 'after step'); invariant(b, 'other connection');
            assert.strictEqual(out.my_vote, v);
        }
        // Final state is the last write per person: s1 +1, s2 −1, s3 +1.
        const c = a.prepare('SELECT score, upvotes, downvotes FROM comments WHERE id = ?').get(comment.id);
        assert.deepStrictEqual(c, { score: 1, upvotes: 2, downvotes: 1 });
    });

    await check('a stale reader cannot overwrite a newer score: the recount reads the rows inside the write lock', () => {
        // Connection b reads, a writes, then b writes: b's score comes from the rows, not from what it read.
        const staleScore = b.prepare('SELECT score FROM comments WHERE id = ?').get(comment.id).score;
        applyVote(a, 'comment', comment.id, subjects[4], 1);
        const out = applyVote(b, 'comment', comment.id, subjects[5], 1);
        assert.strictEqual(out.score, staleScore + 2);
        invariant(a, 'stale reader');
    });

    await check('four worker threads voting concurrently on one comment and one thread: invariants hold, no busy errors', async () => {
        const results = await Promise.all([1, 2, 3, 4].map((n) => new Promise((resolve, reject) => {
            const w = new Worker(__filename, { workerData: { file, seed: n * 7919, ops: 250, subjects, commentId: comment.id, threadId: thread.id } });
            w.once('message', resolve);
            w.once('error', reject);
        })));
        for (const r of results) assert.ok(r.ok, `worker failed: ${r.error}`);
        assert.strictEqual(results.reduce((s, r) => s + r.done, 0), 1000);
        invariant(a, 'after the storm');
        const rows = a.prepare('SELECT COUNT(*) AS n FROM comment_votes WHERE comment_id = ?').get(comment.id).n;
        assert.ok(rows <= subjects.length);
    });

    a.close(); b.close();
    fs.rmSync(dir, { recursive: true, force: true });
    done();
})();
