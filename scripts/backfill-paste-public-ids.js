#!/usr/bin/env node
'use strict';
/**
 * Fill pastes.public_id (migration 0021) in batches. Existing pastes were minted before the id existed; the
 * page route fills one lazily on first read, but this brings every row level at once so the first crawl or
 * export after a deploy sees the canonical /p/<title-slug>-<id> address.
 *
 *   node scripts/backfill-paste-public-ids.js          # batches of 500 until none are left
 *   node scripts/backfill-paste-public-ids.js --batch 2000
 *
 * Safe to run twice: it only touches rows where public_id IS NULL, and the partial unique index keeps every
 * assigned id unique (a collision is reported and the row is left for the next run).
 */
const config = require('../server/config');
const { openDb, closeDb } = require('../server/db');
const { newPublicId } = require('../server/pastes/url');

const batchArg = process.argv.indexOf('--batch');
const BATCH = Math.max(1, Math.min(10000, Number(batchArg > 0 ? process.argv[batchArg + 1] : 500) || 500));

(async () => {
    const db = await openDb(config);
    let total = 0;
    for (;;) {
        const rows = await db.prepare('SELECT id FROM pastes WHERE public_id IS NULL ORDER BY id LIMIT ?').all(BATCH);
        if (!rows.length) break;
        let done = 0;
        for (const row of rows) {
            const info = await db.prepare('UPDATE pastes SET public_id = ? WHERE id = ? AND public_id IS NULL').run(newPublicId(), row.id);
            done += info.changes;
        }
        total += done;
        console.log(`backfilled ${total} paste public id${total === 1 ? '' : 's'}`);
        if (!done) break;
    }
    console.log(total ? `done: ${total} paste public id${total === 1 ? '' : 's'} assigned` : 'done: every paste already has a public id');
    await closeDb();
})().catch((err) => { console.error('backfill failed:', err && err.message ? err.message : err); process.exitCode = 1; });
