'use strict';

/**
 * Retry pending paste reviews (VIS-6 follow-up).
 *
 * A review that could not reach Vision leaves the paste private and `pending`, but keeps the visibility its
 * owner asked for (`review_requested_visibility`, `review_requested_audience`, `review_requested_nsfw`). This
 * job retries with backoff; when Vision answers `fine` it restores that visibility and the share row, so an
 * owner's public paste is not left private by a reviewer outage. A retry that comes back hidden/quarantined
 * stays closed. Off with `COMMUNITY_REVIEW_RETRY_MS=0`; tests call `runOnce()` directly.
 */
function createReviewRetry({ db, review, intervalMs = Number(process.env.COMMUNITY_REVIEW_RETRY_MS || 60_000), log = console } = {}) {
    let timer = null;

    function nextAt(attempts) {
        const seconds = Math.min(6 * 3600, 60 * Math.pow(5, Math.min(5, Math.max(0, attempts))));
        return new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
    }

    async function restore(row) {
        const visibility = row.review_requested_visibility || 'private';
        const nsfw = Number(row.review_requested_nsfw) || 0;
        const audience = row.review_requested_audience
            || (visibility === 'public' ? 'public' : visibility === 'unlisted' ? 'link' : 'private');
        await db.prepare('UPDATE pastes SET visibility = ?, is_nsfw = ? WHERE id = ?').run(visibility, nsfw, row.id);
        await db.prepare("UPDATE shares SET audience = ?, revision = revision + 1 WHERE service = 'community' AND kind = 'paste' AND resource_id = ?")
            .run(audience, row.slug).catch(() => {});
    }

    async function runOnce({ limit = 20 } = {}) {
        if (!db || !review || !review.enabled) return { checked: 0, cleared: 0, closed: 0, failed: 0 };
        const rows = await db.prepare(`SELECT * FROM pastes
            WHERE type = 'screenshot' AND review_status = 'pending' AND deleted_at IS NULL
              AND screenshot_url IS NOT NULL AND (review_next_at IS NULL OR review_next_at <= ov_now())
            ORDER BY updated_at ASC LIMIT ?`).all(Math.min(100, Math.max(1, limit)));
        let cleared = 0; let closed = 0; let failed = 0;
        for (const row of rows) {
            const updated = await review.reviewPaste(db, row, row.screenshot_url);
            if (!updated) { failed++; continue; }
            if (updated.review_category === 'fine') { await restore(updated); cleared++; continue; }
            if (updated.review_status === 'hidden' || updated.review_status === 'quarantined') { closed++; continue; }
            const attempts = Number(row.review_attempts || 0) + 1;
            await db.prepare('UPDATE pastes SET review_attempts = ?, review_next_at = ? WHERE id = ?').run(attempts, nextAt(attempts), row.id);
            failed++;
        }
        if (rows.length) log.log(`[Pastes] review retry: ${rows.length} checked, ${cleared} cleared, ${closed} closed, ${failed} still pending`);
        return { checked: rows.length, cleared, closed, failed };
    }

    function start() {
        if (timer || !intervalMs || !review || !review.enabled) return false;
        timer = setInterval(() => { runOnce().catch((err) => log.warn('[Pastes] review retry:', err.message)); }, intervalMs);
        if (timer.unref) timer.unref();
        return true;
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    return { start, stop, runOnce, nextAt, restore };
}

module.exports = { createReviewRetry };
