#!/usr/bin/env node
'use strict';
// Dry run by default. The explicit --apply mode creates mapped forum views only
// for items the owning service currently confirms are public.
const config = require('../server/config');
const { createDb } = require('openvibe-sdk/db');
const links = require('../server/comments/forum-links');

(async () => {
    const apply = process.argv.includes('--apply');
    if (!config.db.url) throw new Error('DATABASE_URL is required');
    const db = createDb({ url: config.db.url, service: 'community-item-forum-backfill', max: 1 });
    const counts = { checked: 0, eligible_threads: 0, eligible_comments: 0, excluded_threads: 0, moved_threads: 0, moved_comments: 0 };
    const threads = await db.prepare(`SELECT * FROM comment_threads WHERE ref_service IN ('live', 'pics')
        AND ref_type IN ('vod', 'clip', 'picture') AND comment_count > 0 AND forum_thread_id IS NULL ORDER BY id`).all();
    for (const thread of threads) {
        counts.checked++;
        const item = await links.publicExternalItem(thread);
        if (!item) { counts.excluded_threads++; continue; }
        const comments = await db.prepare('SELECT * FROM comments WHERE thread_id = ? ORDER BY id').all(thread.id);
        counts.eligible_threads++;
        counts.eligible_comments += comments.length;
        if (apply) await db.tx(async () => {
            for (const comment of comments) if (await links.syncComment(db, comment, item)) counts.moved_comments++;
            counts.moved_threads++;
        });
    }
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...counts }));
    await db.close();
})().catch((err) => { console.error(`item forum backfill failed: ${err.message}`); process.exitCode = 1; });
