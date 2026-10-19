'use strict';

/**
 * Pinned starter threads (docs/forum/starters.json): one guide per forum, written by the site itself (origin
 * 'system', shown as OpenVibe), so a forum with no posts yet says what belongs in it and how to post. Every boot
 * syncs the file like the Roadmap: a new item becomes a pinned thread in its space; a changed title or body updates
 * the thread (the body as an edit of its opening post, so the history stays); an item that left the file keeps its
 * thread. Items are matched by key (threads.external_key). Staff own the thread once it exists: unpinning, locking
 * or deleting it sticks.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = path.join(__dirname, '..', '..', 'docs', 'forum', 'starters.json');
const KEY = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** items: [{ key, space, title, body }] → { created, updated, unchanged, skipped } */
async function syncStarters(db, items, { log = console } = {}) {
    const out = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (const item of Array.isArray(items) ? items : []) {
        const title = String((item && item.title) || '').replace(/\s+/g, ' ').trim();
        const body = String((item && item.body) || '').trim();
        const space = item && typeof item.space === 'string' ? await store.getSpace(db, item.space) : null;
        if (!item || !KEY.test(String(item.key || '')) || title.length < 3 || title.length > 200 || !body || !space) {
            out.skipped++;
            log.warn && log.warn(`[Starters] skipped an item that is not { key, space, title, body } in a known space: ${JSON.stringify(item && item.key)}`);
            continue;
        }
        const key = `starter:${item.key}`;
        const existing = await store.getThreadByKey(db, space.id, key);
        if (!existing) {
            const { thread } = await store.createThread(db, { space_id: space.id, title, origin: 'system', body_markdown: body, external_key: key });
            await store.setThreadFlags(db, thread.id, { pinned: true });
            out.created++;
            continue;
        }
        if (existing.deleted_at) { out.unchanged++; continue; }
        let changed = false;
        if (existing.title !== title) {
            await db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, existing.id);
            changed = true;
        }
        const opening = await db.prepare('SELECT id, body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1').get(existing.id);
        if (opening && opening.body_markdown !== body) { await store.editPost(db, opening.id, body, 'system'); changed = true; }
        if (changed) out.updated++; else out.unchanged++;
    }
    return out;
}

/** Sync from docs/forum/starters.json (or `file`). A missing or broken file changes nothing. */
async function syncFromFile(db, { file = FILE, log = console } = {}) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { log.warn && log.warn(`[Starters] ${file}: ${err.message}`); return null; }
    return await syncStarters(db, doc.items, { log });
}

module.exports = { syncStarters, syncFromFile, FILE };
