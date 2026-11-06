#!/usr/bin/env node
'use strict';
/**
 * Move existing screenshot pastes' Media objects from "unlisted" to "private" (design 2026-11-06,
 * the Community pilot). New screenshots are uploaded private; this is the one-off for the objects
 * created before that.
 *
 * Media has no route that changes an object's visibility, so a move is a re-host: the bytes are read
 * from the old object's public URL (its id is unguessable, but the URL was handed out), uploaded
 * again as a private object owned by the same person, and the paste row is pointed at the new object.
 * The old object is left in place: nothing is deleted, and the paste can be moved again.
 *
 *   npm run screenshots:private -- --limit 50          # a dry run of 50
 *   npm run screenshots:private -- --apply             # move every one (batches of 50)
 *
 * Idempotent: a paste whose metadata already says media_visibility "private" is skipped.
 */
const { createMediaObjects } = require('../server/media/objects');
const config = require('../server/config');

function parseMeta(raw) {
    if (!raw) return {};
    try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

async function moveScreenshotsPrivate({ db, mediaObjects, fetchImpl = globalThis.fetch, log = console, limit = 50, apply = false } = {}) {
    const rows = await db.prepare(`SELECT id, slug, owner_subject, screenshot_url, media_ref, metadata FROM pastes
        WHERE type = 'screenshot' AND deleted_at IS NULL AND screenshot_url IS NOT NULL
        ORDER BY id LIMIT ?`).all(limit);
    const out = { seen: 0, moved: 0, skipped: 0, failed: 0, failures: [] };
    for (const row of rows) {
        out.seen++;
        const meta = parseMeta(row.metadata);
        if (meta.media_visibility === 'private') { out.skipped++; continue; }
        if (!apply) { out.skipped++; continue; }
        try {
            const res = await fetchImpl(row.screenshot_url, { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) throw new Error(`read ${res.status}`);
            const bytes = Buffer.from(await res.arrayBuffer());
            const mime = meta.mime_type || res.headers.get('content-type') || 'application/octet-stream';
            const owner = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(row.owner_subject || '')) ? row.owner_subject : null;
            const stored = await mediaObjects.uploadImage({
                buffer: bytes, mime, filename: meta.original_name || `${row.slug}.${mime.split('/')[1] || 'bin'}`,
                owner, kind: 'screenshot', source: 'community.paste', visibility: 'private',
            });
            await db.prepare('UPDATE pastes SET screenshot_url = ?, media_ref = ?, metadata = ?, updated_at = ov_now() WHERE id = ?')
                .run(stored.url, stored.id, JSON.stringify({ ...meta, media_visibility: 'private', size_bytes: bytes.length, mime_type: mime }), row.id);
            out.moved++;
            log.log(`moved ${row.slug} → ${stored.id}`);
        } catch (err) {
            out.failed++;
            out.failures.push({ slug: row.slug, error: err.message });
            log.warn(`could not move ${row.slug}: ${err.message}`);
        }
    }
    return out;
}

async function main(argv = process.argv.slice(2)) {
    const apply = argv.includes('--apply');
    const i = argv.indexOf('--limit');
    const limit = i >= 0 ? Math.max(1, parseInt(argv[i + 1], 10) || 50) : (apply ? 500 : 50);
    const { openDb } = require('../server/db');
    const db = await openDb(config);
    try {
        const mediaObjects = createMediaObjects({ config });
        if (!mediaObjects.configured) throw new Error('Media needs Community\'s service principal (OV_OAUTH_CLIENT_SECRET)');
        const out = await moveScreenshotsPrivate({ db, mediaObjects, limit, apply });
        console.log(JSON.stringify(out, null, 2));
        if (!apply) console.log('dry run: pass --apply to move them');
    } finally {
        await db.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });

module.exports = { moveScreenshotsPrivate };
