'use strict';
/**
 * Undo a delete (the owner, 2026-11-12: "a short undo time period on deletion, and undo right on it").
 *
 * The owner's delete hides a paste everywhere at once (deleted_at) and keeps its words and picture for UNDO_MS
 * (purge_after); POST /api/pastes/:slug/restore brings it back until then. This sweep, once a minute, clears what
 * passed its time the way every other delete clears at once: the words, the picture's address, the metadata and the
 * AI notes go, and the picture's Media object is deleted unless another live paste still shows it.
 */
const UNDO_MS = 10 * 60 * 1000;

/** The text form of a time that ov_now() writes ('YYYY-MM-DD HH:MM:SS', UTC), so the two compare as text. */
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function purgeDue(db, { media = null, now = Date.now(), limit = 50, log = console } = {}) {
    const rows = await db.prepare(`SELECT id, slug, media_ref FROM pastes WHERE purge_after IS NOT NULL AND purge_after <= ?
        AND deleted_at IS NOT NULL ORDER BY purge_after LIMIT ?`).all(stamp(now), limit);
    let purged = 0;
    for (const r of rows) {
        const n = (await db.prepare(`UPDATE pastes SET content = NULL, screenshot_url = NULL, metadata = NULL, ai_summary = NULL,
            ai_tags = NULL, purge_after = NULL, updated_at = ov_now() WHERE id = ? AND deleted_at IS NOT NULL AND purge_after IS NOT NULL`).run(r.id)).changes;
        if (!n) continue;
        purged++;
        if (r.media_ref && media && typeof media.remove === 'function') {
            try {
                const other = await db.prepare('SELECT 1 FROM pastes WHERE media_ref = ? AND id <> ? AND deleted_at IS NULL LIMIT 1').get(r.media_ref, r.id);
                if (!other) await media.remove(r.media_ref);
            } catch (err) { log.warn('[Pastes] picture cleanup after undo window failed:', err.message); }
        }
    }
    return { purged };
}

function start({ db, media, intervalMs = 60_000, log = console } = {}) {
    let busy = false;
    const run = async () => {
        if (busy) return;
        busy = true;
        try { await purgeDue(db, { media, log }); } catch (err) { log.warn('[Pastes] undo sweep failed:', err.message); } finally { busy = false; }
    };
    const timer = setInterval(run, Math.max(15_000, Number(intervalMs) || 60_000));
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { UNDO_MS, stamp, purgeDue, start };
