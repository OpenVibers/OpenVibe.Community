'use strict';

/**
 * Pulse store — pure SQL over pulse_items (server/db.js).
 *
 * An item is keyed by its source (service, type, id). Re-recording the same source refreshes
 * its title and link but never its provenance: origin, actor and occurred_at are what the first
 * record said.
 */

/** → { item, created } */
function upsertItem(db, it) {
    const find = db.prepare('SELECT * FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?');
    return db.transaction(() => {
        const key = [it.source_service, it.source_type, String(it.source_id)];
        if (find.get(...key)) {
            db.prepare('UPDATE pulse_items SET title = ?, url = ? WHERE source_service = ? AND source_type = ? AND source_id = ?').run(it.title, it.url, ...key);
            return { item: find.get(...key), created: false };
        }
        db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, origin, visibility, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`).run(...key, it.title, it.url, it.actor_subject || null, it.origin, it.occurred_at);
        return { item: find.get(...key), created: true };
    })();
}

function removeItem(db, service, type, id) {
    return db.prepare('DELETE FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?').run(service, type, String(id)).changes;
}

/**
 * Newest first, keyset-paginated by (occurred_at, id). Community's own items are re-checked
 * against their source at read time — a paste made private, a deleted post or a thread in a
 * space that stopped being public (or became members-only) never shows, even if nothing removed its item.
 *   opts.origin   'user' | 'ai' | 'system'
 *   opts.before   [occurred_at, id] of the last item already seen
 * → { rows, hasMore }
 */
function listItems(db, { origin = null, before = null, limit = 30 } = {}) {
    const rows = db.prepare(`
        SELECT i.* FROM pulse_items i
        WHERE (@origin IS NULL OR i.origin = @origin)
          AND (@at IS NULL OR i.occurred_at < @at OR (i.occurred_at = @at AND i.id < @id))
          AND (i.source_service <> 'community'
               OR (i.source_type = 'paste' AND EXISTS (SELECT 1 FROM pastes p WHERE p.slug = i.source_id AND p.deleted_at IS NULL AND p.visibility = 'public'))
               OR (i.source_type = 'thread' AND EXISTS (SELECT 1 FROM threads t JOIN spaces s ON s.id = t.space_id
                                                        WHERE t.id = CAST(i.source_id AS INTEGER) AND t.deleted_at IS NULL AND s.visibility = 'public'
                                                          AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL))
               OR (i.source_type = 'post' AND EXISTS (SELECT 1 FROM posts po JOIN threads t ON t.id = po.thread_id JOIN spaces s ON s.id = t.space_id
                                                      WHERE po.id = CAST(i.source_id AS INTEGER) AND po.deleted_at IS NULL AND t.deleted_at IS NULL AND s.visibility = 'public'
                                                        AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL)))
        ORDER BY i.occurred_at DESC, i.id DESC
        LIMIT @limit`).all({ origin, at: before ? before[0] : null, id: before ? before[1] : null, limit: limit + 1 });
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

module.exports = { upsertItem, removeItem, listItems };
