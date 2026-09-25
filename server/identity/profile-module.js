'use strict';
/**
 * community.profile on OpenVibe.Network (openvibe-contracts 0.41.0 user module, roadmap WS-B task 9):
 * a person's Community activity for other sites — threads, posts (replies; a thread's opening post is its
 * thread), comments and pastes they wrote and did not delete, and when they were first and last active.
 * Community's rows stay the truth. Written as the owning service (grant community network.modules.write on
 * community.profile), unconditionally, and only when it changed (profile_module_pushes keeps a hash).
 *
 *   scan()  every 5 minutes: authors with a thread, post, comment or paste created, edited or deleted
 *           since the previous scan
 *
 * Off without the OAuth client secret or with COMMUNITY_PROFILE_MODULE=off; only usr_ subjects.
 */
const crypto = require('crypto');

const NS = 'community.profile';
const USR = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const SCAN_MS = 5 * 60 * 1000;

const toIso = (v) => {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function ensureSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS profile_module_pushes (
        subject_id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

/** The record for one person, or null when they wrote nothing. */
function summarize(db, subject) {
    const one = (sql) => db.prepare(sql).get(subject);
    const threads = one("SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM threads WHERE author_subject = ? AND deleted_at IS NULL AND origin = 'user'");
    const posts = one("SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM posts WHERE author_subject = ? AND deleted_at IS NULL AND is_opening = 0 AND origin = 'user'");
    const comments = one("SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM comments WHERE author_subject = ? AND deleted_at IS NULL AND origin = 'user'");
    const pastes = one("SELECT COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM pastes WHERE owner_subject = ? AND deleted_at IS NULL AND origin = 'user' AND visibility = 'public'");
    const all = [threads, posts, comments, pastes];
    if (!all.some((r) => r.n)) return null;
    const firsts = all.map((r) => r.first).filter(Boolean).sort();
    const lasts = all.map((r) => r.last).filter(Boolean).sort();
    return {
        threads: threads.n, posts: posts.n, comments: comments.n, pastes: pastes.n,
        first_active_at: toIso(firsts[0]), last_active_at: toIso(lasts[lasts.length - 1]),
    };
}

function createProfileModule({ db, config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const secret = config && config.oauth && config.oauth.clientSecret;
    const enabled = !!secret && String(process.env.COMMUNITY_PROFILE_MODULE || '').toLowerCase() !== 'off';
    const stats = { written: 0, unchanged: 0, failed: 0, lastError: null };
    let modules = null, lastScan = null, timer = null;

    function client() {
        if (modules) return modules;
        const { createClient } = require('openvibe-sdk/core');
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const { createModulesClient } = require('openvibe-sdk/modules');
        const base = config.networkInternalUrl;
        const tokens = createServiceTokenClient({ tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId || 'community', clientSecret: secret, fetch: fetchImpl });
        const core = createClient({ baseUrls: { network: base }, tokenProvider: tokens, retries: 1, fetch: fetchImpl });
        modules = createModulesClient(core, { baseUrl: base }).forSubject;
        return modules;
    }

    /** Write one person's record when it changed. → true when written */
    async function push(subject) {
        if (!enabled || !USR.test(String(subject || ''))) return false;
        const data = summarize(db, subject);
        if (!data) return false;
        const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32);
        const last = db.prepare('SELECT hash FROM profile_module_pushes WHERE subject_id = ?').get(subject);
        if (last && last.hash === hash) { stats.unchanged++; return false; }
        try { await client().put(NS, subject, data); } catch (err) { stats.failed++; stats.lastError = err.message; return false; }
        db.prepare(`INSERT INTO profile_module_pushes (subject_id, hash, pushed_at) VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(subject_id) DO UPDATE SET hash = excluded.hash, pushed_at = excluded.pushed_at`).run(subject, hash);
        stats.written++;
        return true;
    }

    /** Authors with something created, edited or deleted since the previous scan. → how many were looked at */
    async function scan({ now = Date.now() } = {}) {
        if (!enabled) return 0;
        const from = lastScan || sqlTime(now - 10 * 60 * 1000);
        const to = sqlTime(now);
        const changed = (table, col, cols) => cols.map((c) => `SELECT ${col} AS s FROM ${table} WHERE ${c} >= @from AND ${c} < @to`).join(' UNION ');
        const sql = [
            changed('threads', 'author_subject', ['created_at', 'deleted_at']),
            changed('posts', 'author_subject', ['created_at', 'updated_at', 'deleted_at']),
            changed('comments', 'author_subject', ['created_at', 'updated_at', 'deleted_at']),
            changed('pastes', 'owner_subject', ['created_at', 'updated_at', 'deleted_at']),
        ].join(' UNION ');
        const subjects = db.prepare(sql).all({ from, to }).map((r) => r.s).filter((s) => USR.test(String(s || '')));
        for (const s of subjects) await push(s);
        lastScan = to;
        return subjects.length;
    }

    function start() {
        if (!enabled || timer) return false;
        ensureSchema(db);
        timer = setInterval(() => { scan().catch((err) => { stats.lastError = err.message; }); }, SCAN_MS);
        if (timer.unref) timer.unref();
        log.log && log.log('[Modules] community.profile: scanning every 5 minutes');
        return true;
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { enabled, push, scan, start, stop, stats: () => ({ enabled, ...stats }) };
}

module.exports = { NS, ensureSchema, summarize, createProfileModule };
