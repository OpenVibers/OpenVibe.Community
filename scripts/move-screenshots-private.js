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
 * The old object may be Community's own native object (delete it through the community tenant), an
 * inherited Live-era paste screenshot (`legacy:live:paste:<slug>` in Media's live tenant), or an older
 * Community v1 file (`legacy:community:file:<key>` in the community tenant). Media's tenant-scoped
 * delete answers 404 for the Live one and its v2 delete refuses every legacy object with 409
 * media.object.legacy_managed, so the script retires both through Media's internal legacy route. A
 * legacy object in this community tenant is retired only after checking that no other paste, post,
 * attachment or submission still references its Media id: deleting bytes another page still shows
 * would break it. A 404, 409 or a reference is therefore a failure that keeps `previous_media_ref`:
 * it never means "already gone".
 *
 * --apply pages through every screenshot paste with an id cursor, in batches of --limit (500 by
 * default), so one run reaches every row instead of re-reading the first batch forever. A dry run
 * looks at one batch (50 by default) and prints what it would do: moves, retires and refusals.
 *
 *   npm run screenshots:private -- --limit 50              # a dry run of 50
 *   npm run screenshots:private -- --apply                 # move every one (batches of --limit, 500 by default)
 *   npm run screenshots:private -- --apply --keep-old       # move, but leave the old objects (an operator's call)
 *   npm run screenshots:private -- --retire-ids ids.txt     # dry run of the ids only
 *   npm run screenshots:private -- --apply --retire-ids ids.txt
 *
 * --retire-ids retires only the Media ids in the file, not the paste rows: for an object whose paste
 * record was lost (the three from the 2026-11-06 pilot). One Media id per line; blank lines and `#`
 * comments are ignored, and a line with anything else (the pilot note's "old … new …" lines) is
 * ignored rather than guessed at, so a prose note cannot name an object that must stay.
 *
 * Idempotent: a paste whose metadata says media_visibility "private" is skipped, except that a
 * recorded previous_media_ref is deleted (or retired) on every run. A second retire of the same
 * object is Media's no-op.
 */
const fs = require('fs');
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

/** The Media ids named in a --retire-ids file: exactly one id per line, deduplicated in order. */
function readRetireIds(file) {
    const ids = [];
    for (const line of String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)) {
        const text = line.replace(/#.*$/, '').trim();
        if (MEDIA_RE.test(text) && !ids.includes(text)) ids.push(text);
    }
    return ids;
}

/**
 * The Community rows that still point at one Media id: another paste's media_ref, screenshot_url or
 * metadata, a post body, an attachment, or a submission. Read-only SELECTs against Community's own
 * tables; `exceptPasteId` leaves the paste row being moved out (its previous_media_ref names the
 * object on purpose). Returns [{ table, count }] for the tables with a hit, empty when it is safe to
 * retire the old bytes.
 */
async function referencesToMediaId(db, id, { exceptPasteId = null } = {}) {
    const count = async (sql, ...args) => Number((await db.prepare(sql).get(...args)).n) || 0;
    const hits = [];
    const pastes = await count(`SELECT count(*) AS n FROM pastes
        WHERE deleted_at IS NULL AND id <> ? AND (media_ref = ? OR strpos(coalesce(screenshot_url, ''), ?) > 0 OR strpos(coalesce(metadata, ''), ?) > 0)`,
        exceptPasteId == null ? -1 : exceptPasteId, id, id, id);
    if (pastes) hits.push({ table: 'pastes', count: pastes });
    const posts = await count(`SELECT count(*) AS n FROM posts
        WHERE deleted_at IS NULL AND strpos(coalesce(body_markdown, ''), ?) > 0`, id);
    if (posts) hits.push({ table: 'posts', count: posts });
    const attachments = await count(`SELECT count(*) AS n FROM attachments
        WHERE media_id = ? OR strpos(coalesce(url, ''), ?) > 0`, id, id);
    if (attachments) hits.push({ table: 'attachments', count: attachments });
    const submissions = await count(`SELECT count(*) AS n FROM submissions
        WHERE media_ref = ? OR strpos(coalesce(url, ''), ?) > 0`, id, id);
    if (submissions) hits.push({ table: 'submissions', count: submissions });
    return hits;
}

const describeReferences = (hits) => hits.map((h) => `${h.table} (${h.count})`).join(', ');

/**
 * Move every unprivate screenshot paste, or retire the ids in --retire-ids, or (a dry run) say what
 * would happen. Returns the counts printed by main(); failures never clear previous_media_ref.
 */
async function moveScreenshotsPrivate({ db, mediaObjects, fetchImpl = globalThis.fetch, log = console, limit = 50, apply = false, keepOld = false, retireIds = null } = {}) {
    const pageSize = Math.max(1, parseInt(limit, 10) || 50);
    const out = {
        seen: 0, moved: 0, deleted: 0, retired: 0, alreadyRetired: 0, deleteFailed: 0, retireFailed: 0,
        referenced: 0, refused: 0, notDeletable: 0, skipped: 0, failed: 0, batches: 0, dryRun: !apply,
        plan: { move: 0, retire: 0, refuse: 0 }, failures: [],
    };

    const refuse = (row, id, why) => {
        out.notDeletable++;
        out.failures.push({ slug: row && row.slug, object: id, error: why });
        log.warn(`${row ? row.slug : id}: ${why}; the reference is kept and retried next run`);
    };

    /**
     * Delete Community's own object, or retire a legacy one. A 404 is a legacy Live paste
     * screenshot (another tenant); a 409 media.object.legacy_managed is a legacy object in this
     * tenant (an old Community v1 file). The latter is retired only when no other paste, post or
     * attachment still references it. Any other answer, or a referenced object, is a refusal that
     * keeps previous_media_ref for the next run; none of them means "gone". The reference was
     * written before the delete.
     */
    const removeOld = async (row, meta, id) => {
        const withRef = { ...meta, previous_media_ref: id };
        await db.prepare('UPDATE pastes SET metadata = ?, updated_at = ov_now() WHERE id = ?').run(JSON.stringify(withRef), row.id);
        const retire = async () => {
            try {
                const r = await mediaObjects.retireLegacyPaste(id);
                out.retired++;
                if (r && r.changed === false) out.alreadyRetired++;
                log.log(`${r && r.changed === false ? 'already retired' : 'retired'} legacy old object ${id} of ${row.slug}`);
            } catch (retireErr) {
                out.retireFailed++;
                if (retireErr.status === 409 || retireErr.status === 403 || retireErr.status === 404) out.refused++;
                throw retireErr;
            }
        };
        try {
            try {
                await mediaObjects.deleteObject(id);
                out.deleted++;
                log.log(`deleted old object ${id} of ${row.slug}`);
            } catch (err) {
                if (err.status === 404) {
                    await retire();
                } else if (err.status === 409 && err.code === 'media.object.legacy_managed') {
                    const refs = await referencesToMediaId(db, id, { exceptPasteId: row.id });
                    if (refs.length) {
                        out.referenced++;
                        throw new Error(`still referenced by ${describeReferences(refs)}`);
                    }
                    await retire();
                } else {
                    if (err.status === 409 || err.status === 403) out.refused++;
                    throw err;
                }
            }
            const cleared = { ...withRef };
            delete cleared.previous_media_ref;
            await db.prepare('UPDATE pastes SET metadata = ?, updated_at = ov_now() WHERE id = ?').run(JSON.stringify(cleared), row.id);
            return true;
        } catch (err) {
            out.deleteFailed++;
            out.failures.push({ slug: row.slug, object: id, error: `delete: ${err.message}` });
            log.warn(`old object ${id} of ${row.slug} not deleted (retried next run): ${err.message}`);
            return false;
        }
    };

    const planRef = (row, id) => {
        if (!MEDIA_RE.test(String(id))) {
            out.plan.refuse++;
            refuse(row, id, 'the old screenshot is not a Media v2 object id');
            return;
        }
        out.plan.retire++;
        log.log(`would delete/retire old object ${id} of ${row.slug}`);
    };

    const processRow = async (row) => {
        out.seen++;
        const meta = parseMeta(row.metadata);
        const old = oldObjectId(row);
        // Already private: only a pending old-object delete remains.
        if (meta.media_visibility === 'private') {
            if (meta.previous_media_ref && !keepOld) {
                if (!apply) { planRef(row, String(meta.previous_media_ref)); return; }
                if (!MEDIA_RE.test(String(meta.previous_media_ref))) {
                    refuse(row, String(meta.previous_media_ref), 'the recorded old screenshot is not a Media v2 object id');
                    return;
                }
                await removeOld(row, meta, String(meta.previous_media_ref));
            } else out.skipped++;
            return;
        }
        if (!apply) {
            out.plan.move++;
            log.log(`would move ${row.slug} → private (old object ${old || 'not a Media v2 object'})`);
            if (keepOld) out.skipped++;
            else if (old) planRef(row, old);
            else { out.plan.refuse++; refuse(row, null, 'the old screenshot is not a Media v2 object'); }
            return;
        }
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
                // No Media v2 id (an old /f/ URL or similar): there is nothing to delete this way.
                else refuse(row, null, 'the old screenshot is not a Media v2 object');
            }
        } catch (err) {
            out.failed++;
            out.failures.push({ slug: row.slug, error: err.message });
            log.warn(`could not move ${row.slug}: ${err.message}`);
        }
    };

    // A lost paste record: retire exactly the named objects, no paste scan. A named object is still
    // left alone when a paste, post, attachment or submission points at it.
    if (retireIds) {
        for (const id of retireIds) {
            out.seen++;
            if (!MEDIA_RE.test(String(id))) {
                out.refused++;
                refuse(null, id, 'not a Media object id');
                continue;
            }
            const refs = await referencesToMediaId(db, id);
            if (refs.length) {
                out.referenced++;
                out.refused++;
                out.plan.refuse++;
                const why = `still referenced by ${describeReferences(refs)}`;
                out.failures.push({ object: id, error: why });
                log.warn(`${id} is ${why}; left in place`);
                continue;
            }
            if (!apply) { out.plan.retire++; log.log(`would retire ${id}`); continue; }
            try {
                const r = await mediaObjects.retireLegacyPaste(id);
                out.retired++;
                if (r && r.changed === false) out.alreadyRetired++;
                log.log(`${r && r.changed === false ? 'already retired' : 'retired'} ${id}`);
            } catch (err) {
                out.retireFailed++;
                if (err.status === 409 || err.status === 403 || err.status === 404) out.refused++;
                out.failures.push({ object: id, error: `retire: ${err.message}` });
                log.warn(`could not retire ${id}: ${err.message}`);
            }
        }
        return out;
    }

    // Page with an id cursor: the old `ORDER BY id LIMIT` re-read the same first batch on every run.
    let cursor = 0;
    for (;;) {
        const rows = await db.prepare(`SELECT id, slug, owner_subject, screenshot_url, media_ref, metadata FROM pastes
            WHERE type = 'screenshot' AND deleted_at IS NULL AND screenshot_url IS NOT NULL AND id > ?
            ORDER BY id LIMIT ?`).all(cursor, pageSize);
        out.batches++;
        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) await processRow(row);
        if (!apply) break;                       // a dry run reports one batch
        if (rows.length < pageSize) break;
    }
    return out;
}

async function main(argv = process.argv.slice(2)) {
    const apply = argv.includes('--apply');
    const keepOld = argv.includes('--keep-old');
    const li = argv.indexOf('--limit');
    const limit = li >= 0 ? Math.max(1, parseInt(argv[li + 1], 10) || 50) : (apply ? 500 : 50);
    const ri = argv.indexOf('--retire-ids');
    let retireIds = null;
    if (ri >= 0) {
        const file = argv[ri + 1];
        if (!file || file.startsWith('--')) throw new Error('--retire-ids needs a file of Media object ids');
        retireIds = readRetireIds(file);
        if (!retireIds.length) throw new Error(`no Media object ids in ${file}`);
    }
    const { openDb } = require('../server/db');
    const db = await openDb(config);
    try {
        const mediaObjects = createMediaObjects({ config });
        if (!mediaObjects.configured) throw new Error('Media needs Community\'s service principal (OV_OAUTH_CLIENT_SECRET)');
        const out = await moveScreenshotsPrivate({ db, mediaObjects, limit, apply, keepOld, retireIds });
        console.log(JSON.stringify(out, null, 2));
        if (!apply) console.log(retireIds ? 'dry run: pass --apply to retire these ids' : 'dry run: pass --apply to move them');
    } finally {
        await db.close();
    }
}

if (require.main === module) main().catch((err) => { console.error(err.message || err); process.exitCode = 1; });

module.exports = { moveScreenshotsPrivate, oldObjectId, readRetireIds, referencesToMediaId };
