#!/usr/bin/env node
'use strict';

/**
 * Import OpenVibe.Media's paste export into Community's database.
 *
 *   node scripts/import-pastes.js <bundle.json> [--dry-run] [--id-fix-cutoff 2026-08-20T03:00:26Z]
 *
 * Reads the same environment as the server (.env / /etc/openvibe/community.env):
 * COMMUNITY_DB_PATH, OV_NETWORK_INTERNAL_URL, OV_OAUTH_CLIENT_ID, OV_OAUTH_CLIENT_SECRET (the
 * client needs identity.subject.resolve). Safe to re-run: see server/pastes/importer.js.
 *
 * Exit codes: 0 imported (or dry run finished), 2 bundle refused, 1 anything else.
 */
const fs = require('fs');
const path = require('path');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-pastes.js <bundle.json> [--dry-run] [--id-fix-cutoff <ISO time>]');
    process.exit(msg ? 1 : 0);
}

function parseArgs(argv) {
    const out = { file: null, dryRun: false, cutoff: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--id-fix-cutoff') { out.cutoff = argv[++i]; if (!out.cutoff) usage('--id-fix-cutoff needs a value'); }
        else if (a.startsWith('--id-fix-cutoff=')) out.cutoff = a.slice('--id-fix-cutoff='.length);
        else if (a === '-h' || a === '--help') usage();
        else if (a.startsWith('-')) usage(`unknown option ${a}`);
        else if (!out.file) out.file = a;
        else usage(`unexpected argument ${a}`);
    }
    if (!out.file) usage('missing <bundle.json>');
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const config = require('../server/config');
    const { openDb } = require('../server/db');
    const { createNetworkIdentity } = require('../server/identity/network');
    const { importBundle, formatReport, ImportError, DEFAULT_CUTOFF } = require('../server/pastes/importer');

    let bundle;
    try { bundle = JSON.parse(fs.readFileSync(args.file, 'utf8')); }
    catch (err) { console.error(`Cannot read ${args.file}: ${err.message}`); process.exit(2); }

    const db = openDb(config.dbPath);
    const network = createNetworkIdentity({ config, db });
    try {
        const report = await importBundle(db, bundle, {
            // A dry run writes nothing at all, not even the display cache.
            resolveLegacy: (system, list) => network.resolveLegacy(system, list, { cache: !args.dryRun }),
            cutoff: args.cutoff || DEFAULT_CUTOFF,
            dryRun: args.dryRun,
            source: `${bundle.app || 'media'}:${path.basename(args.file)}`,
        });
        console.log(formatReport(report));
    } catch (err) {
        if (err instanceof ImportError) { console.error(`Refused: ${err.message}`); process.exit(2); }
        throw err;
    } finally {
        db.close();
    }
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
