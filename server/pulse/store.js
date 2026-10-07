'use strict';

/**
 * Pulse store — pure SQL over pulse_items (server/db.js).
 *
 * An item is keyed by its source (service, type, id). Re-recording the same source refreshes
 * its title and link but never its provenance: origin, actor and occurred_at are what the first
 * record said.
 */

/** → { item, created } */
async function upsertItem(db, it) {
    const find = db.prepare('SELECT * FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?');
    return await db.tx(async () => {
        const key = [it.source_service, it.source_type, String(it.source_id)];
        if (await find.get(...key)) {
            await db.prepare('UPDATE pulse_items SET title = ?, url = ? WHERE source_service = ? AND source_type = ? AND source_id = ?').run(it.title, it.url, ...key);
            return { item: await find.get(...key), created: false };
        }
        await db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, origin, visibility, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`).run(...key, it.title, it.url, it.actor_subject || null, it.origin, it.occurred_at);
        return { item: await find.get(...key), created: true };
    });
}

async function removeItem(db, service, type, id) {
    return (await db.prepare('DELETE FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?').run(service, type, String(id))).changes;
}

/**
 * Newest first, keyset-paginated by (occurred_at, id). Community's own items are re-checked
 * against their source at read time — a paste made private, or a submission no longer accepted never shows,
 * even if nothing removed its item.
 *   opts.origin   'user' | 'ai' | 'system'
 *   opts.before   [occurred_at, id] of the last item already seen
 * → { rows, hasMore }
 */
async function listItems(db, { origin = null, before = null, limit = 30 } = {}) {
    const rows = await db.prepare(`
        SELECT i.* FROM pulse_items i
        WHERE (@origin::text IS NULL OR i.origin = @origin)
          AND (@at::text IS NULL OR i.occurred_at < @at OR (i.occurred_at = @at AND i.id < @id::bigint))
          AND (i.source_service <> 'community'
               OR (i.source_type = 'paste' AND EXISTS (SELECT 1 FROM pastes p WHERE p.slug = i.source_id AND p.deleted_at IS NULL AND p.visibility = 'public'))
               OR (i.source_type = 'submission' AND EXISTS (SELECT 1 FROM submissions su WHERE su.slug = i.source_id AND su.status = 'accepted')))
        ORDER BY i.occurred_at DESC, i.id DESC
        LIMIT @limit`).all({ origin, at: before ? before[0] : null, id: before ? before[1] : null, limit: limit + 1 });
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

module.exports = { upsertItem, removeItem, listItems };
