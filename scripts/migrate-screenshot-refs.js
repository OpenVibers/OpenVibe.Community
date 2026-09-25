#!/usr/bin/env node
'use strict';
/**
 * C-24: screenshot pastes stop naming their Media bytes by a legacy reference and name the media object.
 * Pastes imported from Live carry `legacy:live:paste:<Live id>`; Media knows the same screenshot as the
 * object whose legacy_ref is `legacy:live:paste:<slug>`. Pastes uploaded to the v1 file store before the
 * v2 switch carry `legacy:community:file:<key>`, looked up as they are.
 *
 *   node scripts/export-legacy-refs.js --prefix legacy:live:paste: --out refs.json        # on Media (read-only)
 *   node scripts/migrate-screenshot-refs.js --map refs.json                                # dry run (default)
 *   node scripts/migrate-screenshot-refs.js --map refs.json --apply --backup <file.db>     # write
 *
 *   --map <file>     Media's export ({ objects: [{ legacy_ref, id, lifecycle_status }] }); several with commas
 *   --apply          write; without it nothing changes and the report shows what would
 *   --backup <file>  required with --apply: an online backup of Community's database, taken first
 *   --db <file>      Community's database (default: COMMUNITY_DB_PATH / the config)
 *   --report <file>  write the report as JSON too
 *
 * Only the reference changes (screenshot_url stays, so every page keeps working). Objects Media reports
 * deleted or failed, and pastes with no object, keep their legacy reference and are listed. Idempotent.
 * Exit codes: 0 done (or dry run), 2 refused (bad options, backup failed).
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const has = (name) => args.includes(`--${name}`);

async function main() {
    const mapFiles = String(arg('map', '')).split(',').filter(Boolean);
    const apply = has('apply');
    const backup = arg('backup');
    if (!mapFiles.length || (apply && !backup)) { console.error('usage: migrate-screenshot-refs.js --map <refs.json>[,<more>] [--apply --backup <file.db>] [--db <file>] [--report <file>]'); return 2; }
    const byRef = new Map();
    for (const f of mapFiles) for (const o of JSON.parse(fs.readFileSync(f, 'utf8')).objects || []) byRef.set(o.legacy_ref, o);

    const { openDb } = require('../server/db');
    const dbPath = path.resolve(arg('db', process.env.COMMUNITY_DB_PATH || require('../server/config').dbPath));
    const db = openDb(dbPath);
    const rows = db.prepare("SELECT id, slug, media_ref FROM pastes WHERE type = 'screenshot' AND media_ref LIKE 'legacy:%' ORDER BY id").all();
    const report = { db: dbPath, apply, candidates: rows.length, migrated: 0, would_migrate: 0, no_object: [], not_ready: [], changes: [] };
    const plan = [];
    for (const r of rows) {
        const key = /^legacy:live:paste:/.test(r.media_ref) ? `legacy:live:paste:${r.slug}` : r.media_ref;
        const o = byRef.get(key);
        if (!o) { report.no_object.push({ slug: r.slug, media_ref: r.media_ref }); continue; }
        if (!['ready', 'archived'].includes(o.lifecycle_status) || !/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(o.id)) { report.not_ready.push({ slug: r.slug, media_ref: r.media_ref, object: o.id, status: o.lifecycle_status }); continue; }
        plan.push({ id: r.id, slug: r.slug, from: r.media_ref, to: o.id });
    }
    report.changes = plan.slice(0, 20);
    if (!apply) report.would_migrate = plan.length;
    else {
        try { await db.backup(path.resolve(backup)); } catch (err) { console.error(`[migrate-screenshot-refs] backup failed: ${err.message}`); return 2; }
        const set = db.prepare("UPDATE pastes SET media_ref = ? WHERE id = ? AND media_ref = ?");
        report.migrated = db.transaction(() => plan.reduce((n, p) => n + set.run(p.to, p.id, p.from).changes, 0))();
        report.backup = path.resolve(backup);
    }
    const summary = { ...report, no_object: report.no_object.length, not_ready: report.not_ready.length, changes: undefined };
    console.log(JSON.stringify(summary, null, 1));
    if (arg('report')) fs.writeFileSync(arg('report'), JSON.stringify(report, null, 1));
    db.close();
    return 0;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
