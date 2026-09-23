#!/usr/bin/env node
'use strict';

/**
 * Import OpenVibe.Live's own VOD and clip comments into Community comment threads.
 *
 *   node scripts/import-live-comments.js --live-db <live.db>                              # dry run (default)
 *   node scripts/import-live-comments.js --live-db <live.db> --apply --backup <file.db>   # write
 *
 * Options:
 *   --live-db <file>       Live's database, opened read-only (required)
 *   --community-db <file>  Community's database (default: COMMUNITY_DB_PATH, as the server)
 *   --apply                write; without it nothing is written and the report shows what would be
 *   --backup <file>        required with --apply: an online backup of Community's database is written
 *                          here (must not exist yet) and checked before anything changes
 *   --live-links-only      name authors from Live's linked_accounts only (no Network call)
 *
 * Reads the same environment as the server (.env / /etc/openvibe/community.env):
 * COMMUNITY_DB_PATH, OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET (the
 * client needs identity.subject.resolve on openvibe.network). Safe to re-run: the ledger
 * (legacy_id_map live/comment) skips rows already imported. See server/comments/live-import.js.
 *
 * Exit codes: 0 done (or dry run finished), 2 refused (bad options, backup failed, reconciliation
 * failed), 1 anything else.
 */
const fs = require('fs');
const path = require('path');

function usage(msg, code = msg ? 2 : 0) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-live-comments.js --live-db <live.db> [--community-db <community.db>] [--apply --backup <file>] [--live-links-only]');
    process.exit(code);
}

function parseArgs(argv) {
    const out = { liveDb: null, communityDb: null, apply: false, backup: null, liveLinksOnly: false };
    const value = (i, name) => { const v = argv[i]; if (!v || v.startsWith('--')) usage(`${name} needs a value`); return v; };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--live-db') out.liveDb = value(++i, a);
        else if (a === '--community-db') out.communityDb = value(++i, a);
        else if (a === '--backup') out.backup = value(++i, a);
        else if (a === '--apply') out.apply = true;
        else if (a === '--dry-run') out.apply = false;
        else if (a === '--live-links-only') out.liveLinksOnly = true;
        else if (a === '-h' || a === '--help') usage();
        else usage(`unknown argument ${a}`);
    }
    if (!out.liveDb) usage('missing --live-db');
    if (out.apply && !out.backup) usage('--apply needs --backup <file>: a backup of Community\'s database is taken first');
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const Database = require('better-sqlite3');
    const config = require('../server/config');
    const { openDb } = require('../server/db');
    const { importLiveComments, formatReport, LiveImportError } = require('../server/comments/live-import');

    if (!fs.existsSync(args.liveDb)) usage(`no Live database at ${args.liveDb}`);
    const communityPath = args.communityDb || config.dbPath;
    if (!fs.existsSync(communityPath)) usage(`no Community database at ${communityPath}`);
    // Opening runs the additive schema migrations; a dry run must not be what applies them.
    {
        const probe = new Database(communityPath, { readonly: true, fileMustExist: true });
        const cols = new Set(probe.prepare('PRAGMA table_info(comments)').all().map((c) => c.name));
        probe.close();
        if (!cols.has('edited_at')) usage(`Community's database at ${communityPath} predates this importer: deploy and restart Community first`);
    }

    const liveDb = new Database(args.liveDb, { readonly: true, fileMustExist: true });
    const db = openDb(communityPath);
    try {
        if (args.apply) {
            const target = path.resolve(args.backup);
            if (fs.existsSync(target)) usage(`${target} exists already; pick a new backup file`);
            await db.backup(target);
            const check = new Database(target, { readonly: true, fileMustExist: true });
            const ok = check.pragma('integrity_check', { simple: true });
            const counts = check.prepare('SELECT (SELECT COUNT(*) FROM comments) AS comments, (SELECT COUNT(*) FROM comment_threads) AS threads').get();
            check.close();
            if (ok !== 'ok') { console.error(`Refused: the backup at ${target} failed its integrity check (${ok})`); process.exit(2); }
            console.log(`Backup: ${target} (integrity ok; ${counts.comments} comments in ${counts.threads} threads)`);
        }

        let resolveLegacy = null;
        if (!args.liveLinksOnly) {
            const { createNetworkIdentity } = require('../server/identity/network');
            const network = createNetworkIdentity({ config, db });
            // A dry run writes nothing at all, not even the display cache.
            resolveLegacy = (system, ids) => network.resolveLegacy(system, ids, { cache: args.apply });
        }
        const report = await importLiveComments(db, liveDb, {
            resolveLegacy, dryRun: !args.apply, source: path.basename(args.liveDb),
        });
        console.log(formatReport(report));
        if (!args.apply) console.log('\nNothing was written. Re-run with --apply --backup <file> to import.');
    } catch (err) {
        if (err instanceof LiveImportError) { console.error(`Refused: ${err.message}`); process.exit(2); }
        throw err;
    } finally {
        liveDb.close();
        db.close();
    }
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
