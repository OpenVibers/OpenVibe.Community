'use strict';

/**
 * Pulse store — pure SQL over pulse_items (server/db.js).
 *
 * An item is keyed by its source (service, type, id). Re-recording the same source refreshes
 * its title and link but never its provenance: origin, actor and occurred_at are what the first
 * record said.
 *
 * A live stream is the exception: a dropped connection starts a new Live session (a new subject
 * id), but it is the same broadcast. upsertLiveItem keeps one item for the same person (or the
 * same channel URL) and title within six hours and moves its time to the newest start. Existing
 * duplicates are collapsed the same way when the feed is read, so the page shows one line.
 */
const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** A live.stream.started item: one row per broadcast, not per reconnect. → { item, created } */
async function upsertLiveItem(db, it) {
    const find = db.prepare('SELECT * FROM pulse_items WHERE source_service = ? AND source_type = ? AND source_id = ?');
    return await db.tx(async () => {
        const key = [it.source_service, it.source_type, String(it.source_id)];
        const existing = await find.get(...key);
        if (existing) {
            await db.prepare('UPDATE pulse_items SET title = ?, url = ? WHERE source_service = ? AND source_type = ? AND source_id = ?').run(it.title, it.url, ...key);
            return { item: await find.get(...key), created: false };
        }
        const at = Date.parse(String(it.occurred_at || ''));
        const actor = it.actor_subject || null;
        if (Number.isFinite(at)) {
            // The same person (or channel URL) and title within six hours of this start is the same
            // broadcast. Older sessions only: a delayed event must not move a newer item back in time.
            const candidates = actor
                ? await db.prepare(`SELECT * FROM pulse_items
                        WHERE source_service = 'live' AND source_type = 'stream' AND title = ?
                          AND ((actor_subject IS NOT NULL AND actor_subject = ?) OR url = ?)
                        ORDER BY occurred_at DESC, id DESC`).all(it.title, actor, it.url)
                : await db.prepare(`SELECT * FROM pulse_items
                        WHERE source_service = 'live' AND source_type = 'stream' AND title = ? AND url = ?
                        ORDER BY occurred_at DESC, id DESC`).all(it.title, it.url);
            let prior = null, priorAt = -Infinity;
            for (const c of candidates) {
                const t = Date.parse(c.occurred_at);
                if (Number.isFinite(t) && t <= at && at - t <= LIVE_WINDOW_MS && t > priorAt) { prior = c; priorAt = t; }
            }
            if (prior) {
                if (at > priorAt) await db.prepare('UPDATE pulse_items SET occurred_at = ? WHERE id = ?').run(it.occurred_at, prior.id);
                return { item: await db.prepare('SELECT * FROM pulse_items WHERE id = ?').get(prior.id), created: false };
            }
        }
        await db.prepare(`INSERT INTO pulse_items (source_service, source_type, source_id, title, url, actor_subject, origin, visibility, occurred_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'public', ?)`).run(...key, it.title, it.url, actor, it.origin, it.occurred_at);
        return { item: await find.get(...key), created: true };
    });
}

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
 * against their source at read time — a paste made private, a deleted post, a submission no longer
 * accepted or a thread in a space that stopped being public (or became members-only) never shows,
 * even if nothing removed its item. Live streams recorded before upsertLiveItem existed are
 * collapsed here too: an older session is hidden when the same person (or URL) and title started
 * again within six hours, so one line and its newest time remain.
 *   opts.origin   'user' | 'ai' | 'system'
 *   opts.before   [occurred_at, id] of the last item already seen
 * → { rows, hasMore }
 */
async function listItems(db, { origin = null, before = null, limit = 30 } = {}) {
    const rows = await db.prepare(`
        SELECT i.* FROM pulse_items i
        WHERE (@origin::text IS NULL OR i.origin = @origin)
          AND (@at::text IS NULL OR i.occurred_at < @at OR (i.occurred_at = @at AND i.id < @id::bigint))
          AND NOT (i.source_service = 'live' AND i.source_type = 'stream' AND EXISTS (
                   SELECT 1 FROM pulse_items j
                   WHERE j.source_service = 'live' AND j.source_type = 'stream'
                     AND j.title = i.title
                     AND ((j.actor_subject IS NOT NULL AND j.actor_subject = i.actor_subject) OR j.url = i.url)
                     AND (j.occurred_at > i.occurred_at OR (j.occurred_at = i.occurred_at AND j.id > i.id))
                     AND j.occurred_at::timestamptz <= i.occurred_at::timestamptz + INTERVAL '6 hours'))
          AND (i.source_service <> 'community'
               OR (i.source_type = 'paste' AND EXISTS (SELECT 1 FROM pastes p WHERE p.slug = i.source_id AND p.deleted_at IS NULL AND p.visibility = 'public'))
               OR (i.source_type = 'thread' AND EXISTS (SELECT 1 FROM threads t JOIN spaces s ON s.id = t.space_id
                                                        WHERE t.id = CAST(i.source_id AS INTEGER) AND t.deleted_at IS NULL AND s.visibility = 'public'
                                                          AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL))
               OR (i.source_type = 'post' AND EXISTS (SELECT 1 FROM posts po JOIN threads t ON t.id = po.thread_id JOIN spaces s ON s.id = t.space_id
                                                      WHERE po.id = CAST(i.source_id AS INTEGER) AND po.deleted_at IS NULL AND t.deleted_at IS NULL AND s.visibility = 'public'
                                                        AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL))
               OR (i.source_type = 'submission' AND EXISTS (SELECT 1 FROM submissions su WHERE su.slug = i.source_id AND su.status = 'accepted')))
        ORDER BY i.occurred_at DESC, i.id DESC
        LIMIT @limit`).all({ origin, at: before ? before[0] : null, id: before ? before[1] : null, limit: limit + 1 });
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

module.exports = { upsertItem, upsertLiveItem, removeItem, listItems };
