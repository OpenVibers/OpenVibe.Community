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
 * Once the row points at the new object the old one is deleted from Media: leaving it behind would
 * let anyone who ever held its URL keep reading a screenshot of a paste that is now people/private.
 * The old id is recorded as `previous_media_ref` before the delete, so a failed delete is retried on
 * the next run instead of being forgotten.
 *
 *   npm run screenshots:private -- --limit 50          # a dry run of 50
 *   npm run screenshots:private -- --apply             # move every one (batches of 50)
 *   npm run screenshots:private -- --apply --keep-old  # move, but leave the old objects (an operator's call)
 *
 * Idempotent: a paste whose metadata says media_visibility "private" is skipped, except that a
 * recorded previous_media_ref is deleted (or retried) on every run.
 */
const { createMediaObjects } = require('../server/media/objects');
const config = require('../server/config');

const MEDIA_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;

function parseMeta(raw) {
    if (!raw) return {};
    try { const o = typeof raw === 'string' ? JSON.parse(raw) : raw; return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

/** The Media v2 id a paste's old screenshot points at (its media_ref, else the id in its URL), or null. */
function oldObjectId(row) {
    if (MEDIA_RE.test(String(row.media_ref || ''))) return String(row.media_ref);
    const m = String(row.screenshot_url || '').match(/\/o\/(med_[0-9A-HJKMNP-TV-Z]{26})/);
    return m ? m[1] : null;
}

async function moveScreenshotsPrivate({ db, mediaObjects, fetchImpl = globalThis.fetch, log = console, limit = 50, apply = false, keepOld = false } = {}) {
    const rows = await db.prepare(`SELECT id, slug, owner_subject, screenshot_url, media_ref, metadata FROM pastes
        WHERE type = 'screenshot' AND deleted_at IS NULL AND screenshot_url IS NOT NULL
        ORDER BY id LIMIT ?`).all(limit);
    const out = { seen: 0, moved: 0, deleted: 0, deleteFailed: 0, notDeletable: 0, skipped: 0, failed: 0, failures: [] };

    const removeOld = async (row, meta, id) => {
        // previous_media_ref is written before the delete: a crash or a refusal leaves a retryable record.
        const withRef = { ...meta, previous_media_ref: id };
        await db.prepare('UPDATE pastes SET metadata = ?, updated_at = ov_now() WHERE id = ?').run(JSON.stringify(withRef), row.id);
        try {
            await mediaObjects.deleteObject(id);
            const cleared = { ...withRef };
            delete cleared.previous_media_ref;
            await db.prepare('UPDATE pastes SET metadata = ?, updated_at = ov_now() WHERE id = ?').run(JSON.stringify(cleared), row.id);
            out.deleted++;
            log.log(`deleted old object ${id} of ${row.slug}`);
            return true;
        } catch (err) {
            out.deleteFailed++;
            out.failures.push({ slug: row.slug, object: id, error: `delete: ${err.message}` });
            log.warn(`old object ${id} of ${row.slug} not deleted (retried next run): ${err.message}`);
            return false;
        }
    };

    for (const row of rows) {
        out.seen++;
        const meta = parseMeta(row.metadata);
        const old = oldObjectId(row);
        // Already private: only a pending old-object delete remains.
        if (meta.media_visibility === 'private') {
            if (meta.previous_media_ref && !keepOld) {
                if (!apply) { out.skipped++; continue; }
                if (!MEDIA_RE.test(String(meta.previous_media_ref))) { out.notDeletable++; continue; }
                await removeOld(row, meta, String(meta.previous_media_ref));
            } else out.skipped++;
            continue;
        }
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
            const next = { ...meta, media_visibility: 'private', size_bytes: bytes.length, mime_type: mime };
            await db.prepare('UPDATE pastes SET screenshot_url = ?, media_ref = ?, metadata = ?, updated_at = ov_now() WHERE id = ?')
                .run(stored.url, stored.id, JSON.stringify(next), row.id);
            out.moved++;
            log.log(`moved ${row.slug} → ${stored.id}`);
            if (!keepOld) {
                if (old) await removeOld(row, next, old);
                // A legacy:community:file object has no v2 id to delete; it is left in place and said so.
                else { out.notDeletable++; log.warn(`${row.slug}: the old screenshot is not a Media v2 object; left in place`); }
            }
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
    const keepOld = argv.includes('--keep-old');
    const i = argv.indexOf('--limit');
    const limit = i >= 0 ? Math.max(1, parseInt(argv[i + 1], 10) || 50) : (apply ? 500 : 50);
    const { openDb } = require('../server/db');
    const db = await openDb(config);
    try {
        const mediaObjects = createMediaObjects({ config });
        if (!mediaObjects.configured) throw new Error('Media needs Community\'s service principal (OV_OAUTH_CLIENT_SECRET)');
        const out = await moveScreenshotsPrivate({ db, mediaObjects, limit, apply, keepOld });
        console.log(JSON.stringify(out, null, 2));
        if (!apply) console.log('dry run: pass --apply to move them');
    } finally {
        await db.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });

module.exports = { moveScreenshotsPrivate, oldObjectId };
