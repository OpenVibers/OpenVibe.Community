'use strict';

/**
 * The Roadmap space (WS-J task 8): OpenVibe's public roadmap summary (docs/roadmap/public.json) as one
 * thread per item, written by the site itself (origin 'system', shown as OpenVibe). Every boot syncs the
 * file: a new item becomes a thread; a changed title, status, category or summary updates the item's
 * thread (the summary as an edit of its opening post, so the history stays); an item that left the file
 * keeps its thread. Items are matched by key (threads.external_key), so replies and votes stay with them.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { STATUSES } = require('./service');

const FILE = path.join(__dirname, '..', '..', 'docs', 'roadmap', 'public.json');
const KEY = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** items: [{ key, title, status, category?, summary }] → { created, updated, unchanged, skipped } */
function syncRoadmap(db, items, { log = console } = {}) {
    const out = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    const space = store.getSpace(db, 'roadmap');
    if (!space) return out;
    for (const item of Array.isArray(items) ? items : []) {
        const title = String((item && item.title) || '').replace(/\s+/g, ' ').trim();
        const summary = String((item && item.summary) || '').trim();
        if (!item || !KEY.test(String(item.key || '')) || title.length < 3 || title.length > 200 || !summary || !STATUSES.roadmap.includes(item.status)) {
            out.skipped++;
            log.warn && log.warn(`[Roadmap] skipped an item that is not { key, title, status, summary }: ${JSON.stringify(item && item.key)}`);
            continue;
        }
        const category = item.category ? store.getCategory(db, space.id, item.category) : null;
        const categoryId = category ? category.id : null;
        const existing = store.getThreadByKey(db, space.id, item.key);
        if (!existing) {
            store.createThread(db, { space_id: space.id, title, origin: 'system', body_markdown: summary, kind: 'roadmap', status: item.status, category_id: categoryId, external_key: item.key });
            out.created++;
            continue;
        }
        let changed = false;
        if (existing.title !== title || existing.status !== item.status || (existing.category_id || null) !== categoryId) {
            db.prepare('UPDATE threads SET title = ?, status = ?, category_id = ? WHERE id = ?').run(title, item.status, categoryId, existing.id);
            changed = true;
        }
        const opening = db.prepare('SELECT id, body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1').get(existing.id);
        if (opening && opening.body_markdown !== summary) { store.editPost(db, opening.id, summary, 'system'); changed = true; }
        if (changed) out.updated++; else out.unchanged++;
    }
    return out;
}

/** Sync from docs/roadmap/public.json (or `file`). A missing or broken file changes nothing. */
function syncFromFile(db, { file = FILE, log = console } = {}) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { log.warn && log.warn(`[Roadmap] ${file}: ${err.message}`); return null; }
    return syncRoadmap(db, doc.items, { log });
}

module.exports = { syncRoadmap, syncFromFile, FILE };
