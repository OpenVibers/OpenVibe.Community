'use strict';
/**
 * Track O: truthful readiness for GET /api/ready (openvibe-shared/ready).
 *
 *   db              required  a real query on Community's PostgreSQL database (the schema is there and answers)
 *   network_jwks    optional  the Network signing key has loaded. Without it public pages and reads
 *                             still work, but nobody can sign in or write as a signed-in viewer or
 *                             service (those answer 503), so it degrades rather than fails
 *   media           optional  Media answers /healthz (screenshot and file uploads; paste text is local)
 *
 * Request metrics come from openvibe-shared/metrics in app.js. Content counts (pastes, comments,
 * threads) are deliberately not metrics.
 */
const { createReadiness } = require('openvibe-shared/ready');

const PING_TTL_MS = 15_000;

function probe(url, fetchImpl) {
    return async () => {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000), headers: { Accept: 'application/json' } });
        try { await res.body?.cancel(); } catch { /* not needed */ }
        return res.ok ? { ok: true, detail: { http_status: res.status } } : { ok: false, error: `answered HTTP ${res.status}`, detail: { http_status: res.status } };
    };
}

function createCommunityReadiness({ db, auth, config, relay = null, release = null, fetchImpl = globalThis.fetch, valkey = null }) {
    const checks = [
        {
            name: 'db', required: true,
            // A real round trip that names the store (postgresql / pglite), and a migrated schema.
            check: async () => {
                const r = await db.ready();
                if (!r.ok) return r.error;
                const n = (await db.prepare('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema()').get()).n;
                return n > 0 ? { ok: true, detail: r.detail } : 'database has no tables (migrations did not run)';
            },
        },
        { name: 'valkey', required: false, check: async () => (valkey ? valkey.ready() : { skipped: 'VALKEY_URL not set: per-actor limits count in this process only' }) },
        {
            name: 'network_jwks', required: false,
            check: () => {
                if (auth.client.publicKey) return true;
                // Not loaded: ask again (ensureKey throttles itself to one fetch per 30 s) and report now.
                auth.ensureKey().catch(() => {});
                return 'Network signing key not loaded yet: sign-in and signed-in writes are unavailable';
            },
        },
    ];
    checks.push({ name: 'media', required: false, cacheMs: PING_TTL_MS, timeoutMs: 2500, check: probe(`${config.mediaInternalUrl}/healthz`, fetchImpl) });
    return createReadiness({
        service: 'community',
        release,
        checks,
        details: async (body) => {
            const out = {};
            if (relay && relay.enabled && body.checks.db.status === 'ok') {
                // The queue by status (failed = dead letters), and whether the Events worker and the inbound gateway run.
                const st = await relay.status();
                const brief = (x) => (x.enabled ? { enabled: true, state: x.state || (x.running ? 'running' : 'stopped'), last_error: x.last_error || null, ...(x.lag != null ? { lag: x.lag } : {}) } : { enabled: false, reason: x.reason });
                out.discord_relay = { enabled: true, deliveries: st.deliveries, creates_from: st.creates_from, events_worker: brief(st.events_worker), inbound: brief(st.inbound), inbound_failures: st.inbound_failures };
            }
            return out;
        },
    });
}

module.exports = { createCommunityReadiness };
