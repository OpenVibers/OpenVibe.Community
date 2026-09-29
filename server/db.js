'use strict';

/**
 * Community's own database: PostgreSQL (ADR-035, roadmap WS-X2). The schema is migrations/NNNN_*.sql, applied at boot.
 *
 * Community is the authority for pastes once PASTES_AUTHORITY=community: pastes, their edit
 * history, likes and comments live here. Typed comment threads, the forum (spaces, threads,
 * posts), the Discord relay's bookkeeping and Pulse live here in every mode. People are referenced by Network subject ids
 * (usr_… / gst_…), never by a service-local integer; subject_projection is only a display cache
 * of what the Network says about them.
 *
 * Timestamps are text ('YYYY-MM-DD HH:MM:SS', UTC): the schema defines ov_now(), datetime() and julianday()
 * with those semantics, and ov_hot() for the forum's hot rank.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createDb } = require('openvibe-sdk/db');

const MIGRATIONS = path.join(__dirname, '..', 'migrations');
const DEV_PGLITE = path.join(__dirname, '..', 'data', 'pglite');

/**
 * The serving handle (ADR-035): DATABASE_URL through PgBouncer; in development without it, an embedded PGlite database
 * in data/pglite. Migrations run first, as the owner (DATABASE_DIRECT_URL), or on the embedded handle.
 */
async function openDb(config, { log = console, registry } = {}) {
    if (!config.db.url) {
        if (config.isProduction) throw new Error('DATABASE_URL is not set: production serves from PostgreSQL (OpenVibe.Host roles/data add-service.sh community)');
        const dir = process.env.COMMUNITY_PGLITE_DIR || DEV_PGLITE;   // tests that boot the real server give it a directory of its own
        log.warn(`[Community] DATABASE_URL unset: embedded PGlite database in ${dir} (development only, one process)`);
        fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir, service: 'community', registry, log });
        await db.migrate({ dir: MIGRATIONS, log });
        return db;
    }
    if (!config.db.directUrl) throw new Error('DATABASE_DIRECT_URL is not set: migrations run with the owner role on a direct connection');
    const owner = createDb({ url: config.db.directUrl, service: 'community-migrate', max: 1, log });
    try { await owner.migrate({ dir: MIGRATIONS, log }); } finally { await owner.close(); }
    return createDb({ url: config.db.url, service: 'community', registry, log });
}

/** cth_ + 22 base64url characters (16 random bytes). */
function newThreadAccessId() { return `cth_${crypto.randomBytes(16).toString('base64url')}`; }

let _shared = null;
/** Open the process-wide database once, at boot (server/index.js). */
async function initDb(config, opts) {
    if (!_shared) _shared = await openDb(config, opts);
    return _shared;
}
/** The process-wide database initDb() opened. */
function getDb() {
    if (!_shared) throw new Error('the database is not open: await initDb(config) at boot');
    return _shared;
}
/** Tests: use this handle as the process-wide database. */
function setDb(db) { _shared = db; }

/** Graceful stop: close the process-wide database. */
async function closeDb() {
    const db = _shared;
    _shared = null;
    if (db) await db.close().catch(() => {});
}

module.exports = { openDb, initDb, getDb, setDb, closeDb, MIGRATIONS, newThreadAccessId };
