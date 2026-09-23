'use strict';
/** Track O: GET /metrics is loopback-only with route templates; /api/ready reports what is actually served. */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');

function raw(base, path, headers = {}) {
    return new Promise((resolve, reject) => http.get(base + path, { headers }, (res) => {
        let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
}

(async () => {
    const t = await boot();
    // Let the boot-time key fetch land.
    await t.app.locals.auth.ensureKey();

    await check('live mode: ready, with db required and Network key and Live optional', async () => {
        const r = await t.get('/api/ready');
        assert.strictEqual(r.status, 200, r.text);
        const b = r.json();
        assert.strictEqual(b.ready, true);
        assert.strictEqual(b.status, 'ready');
        assert.strictEqual(b.service, 'community');
        assert.strictEqual(b.pastes_authority, 'live');
        assert.deepStrictEqual(Object.keys(b.checks), ['db', 'network_jwks', 'live']);
        assert.strictEqual(b.checks.db.required, true);
        assert.strictEqual(b.checks.network_jwks.required, false);
        assert.strictEqual(b.checks.live.required, false);
        for (const c of Object.values(b.checks)) {
            assert.strictEqual(c.status, 'ok');
            assert.strictEqual(typeof c.latency_ms, 'number');
            assert.ok(Date.parse(c.checked_at));
        }
    });

    await check('/metrics: 404 through a proxy, route templates (never slugs or ids) to a loopback caller', async () => {
        await t.get('/api/pastes/abc123secretslug');
        await t.get('/p/another-secret-slug');
        await t.get('/no/such/page/99999');
        const proxied = await raw(t.base, '/metrics', { 'X-Forwarded-For': '203.0.113.9' });
        assert.strictEqual(proxied.status, 404);
        const m = await raw(t.base, '/metrics');
        assert.strictEqual(m.status, 200);
        assert.ok(/http_requests_total\{method="GET",route="\/api\/ready",status_class="2xx"\} 1/.test(m.body), m.body.slice(0, 2000));
        assert.ok(m.body.includes('route="/p/:slug"'));
        const labels = m.body.split('\n').filter((l) => l.startsWith('http_')).map((l) => (l.match(/\{[^}]*\}/) || [''])[0]).join('\n');
        assert.ok(!/secret|99999/.test(labels), 'no raw paths in labels');
        assert.ok(/release_info\{service="community",release="[0-9a-f]{7,12}"\} 1/.test(m.body));
        assert.ok(!/pastes_total|comments_total|threads_total/.test(m.body), 'no content counts');
    });

    await check('/release.json is a valid release manifest (Track R) and POST /release-metrics feeds /metrics', async () => {
        const r = await t.get('/release.json');
        assert.strictEqual(r.status, 200, r.text);
        const rel = r.json();
        assert.strictEqual(rel.service, 'community');
        assert.deepStrictEqual(require('openvibe-contracts').validate('registry.release-manifest@1', rel).errors, []);
        assert.strictEqual(rel.metrics_url, '/release-metrics');
        // release-watch's beacon: same-origin, text/plain, no auth.
        const b = await t.get('/release-metrics', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ counts: { reloaded: { user: 2 } } }) });
        assert.strictEqual(b.status, 204, b.text);
        const m = await raw(t.base, '/metrics');
        assert.ok(/release_client_updates_total\{outcome="reloaded",reason="user"\} 2/.test(m.body), m.body.split('\n').filter((l) => l.includes('release_client')).join('\n'));
    });

    await check('Live down: still ready (comments, forum and Pulse are served), live degraded', async () => {
        await t.live.close();
        await new Promise((r) => setTimeout(r, 20));
        // The Live probe is cached for 15 s; a fresh app instance sees the outage immediately.
        const { createCommunityReadiness } = require('../server/observability');
        const rd = createCommunityReadiness({ db: t.app.locals.db, auth: t.app.locals.auth, config: t.app.locals.config });
        const b = await rd.run();
        assert.strictEqual(b.ready, true);
        assert.strictEqual(b.status, 'degraded');
        assert.deepStrictEqual(b.degraded, ['live']);
    });

    await check('Network key not loaded: degraded, not down', async () => {
        const { createCommunityReadiness } = require('../server/observability');
        const auth = { client: { publicKey: null }, ensureKey: async () => null };
        const b = await createCommunityReadiness({ db: t.app.locals.db, auth, config: { ...t.app.locals.config, pastesAuthority: 'community', mediaInternalUrl: t.media.url } }).run();
        assert.strictEqual(b.ready, true);
        assert.deepStrictEqual(b.degraded, ['network_jwks']);
        assert.strictEqual(b.checks.media.status, 'ok', 'community mode probes Media instead of Live');
        assert.match(b.checks.network_jwks.error, /not loaded/);
    });

    await check('database unusable: 503 not_ready with db failed', async () => {
        t.app.locals.db.close();
        const r = await t.get('/api/ready');
        assert.strictEqual(r.status, 503);
        const b = r.json();
        assert.strictEqual(b.ready, false);
        assert.deepStrictEqual(b.failed, ['db']);
    });

    await t.close().catch(() => {});
    done();
})();
