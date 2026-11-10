'use strict';

const crypto = require('crypto');

/** Fill at most one small batch of legacy paste hashes. Media owns screenshot bytes and supplies their stored hash. */
async function fillBatch({ db, media, screenshots, limit = 50 } = {}) {
    const batch = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = await db.prepare(`SELECT id, type, content, media_ref, screenshot_url FROM pastes
        WHERE deleted_at IS NULL AND content_hash IS NULL ORDER BY id LIMIT ?`).all(batch);
    let filled = 0;
    for (const row of rows) {
        let contentHash = null;
        if (row.type === 'paste' && row.content != null) {
            contentHash = crypto.createHash('sha256').update(String(row.content), 'utf8').digest('hex');
        } else if (row.type === 'screenshot' && /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(row.media_ref || '')) && media?.object) {
            try {
                const object = await media.object(row.media_ref);
                if (/^[a-f0-9]{64}$/i.test(String(object && object.content_hash || ''))) contentHash = String(object.content_hash).toLowerCase();
            } catch { /* retry this object on the next bounded run */ }
        } else if (row.type === 'screenshot' && screenshots?.bytes) {
            try {
                const bytes = await screenshots.bytes(row);
                if (bytes && bytes.body) contentHash = crypto.createHash('sha256').update(bytes.body).digest('hex');
            } catch { /* retry this object on the next bounded run */ }
        }
        if (!contentHash) continue;
        const result = await db.prepare(`UPDATE pastes SET content_hash = ?, source_hash = COALESCE(source_hash, ?)
            WHERE id = ? AND content_hash IS NULL`).run(contentHash, contentHash, row.id);
        if (result.changes) filled++;
    }
    return { scanned: rows.length, filled };
}

function start({ db, media, screenshots, intervalMs = 60_000, log = console } = {}) {
    const run = () => fillBatch({ db, media, screenshots }).catch((err) => log.warn('[Paste hashes] batch failed:', err.message));
    run();
    const timer = setInterval(run, Math.max(15_000, Number(intervalMs) || 60_000));
    if (timer.unref) timer.unref();
    return timer;
}

module.exports = { fillBatch, start };
