'use strict';
/**
 * /openapi.json documents this service's API, and the document is the API: every route it lists is a
 * route the app mounts, and every mounted /api route is listed (the operational probes /api/health and
 * /api/ready excepted). The mounted set is read from the router stack by test/helpers/routes.js — the
 * same walk the security tests crawl — so a route added, renamed or removed without the document fails
 * here.
 *
 *   node test/openapi.test.js
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { listRoutes } = require('./helpers/routes');
const { routes } = require('../server/openapi');

const PROBES = new Set(['GET /api/health', 'GET /api/ready', 'GET /api/v1/openapi.json']);

/** The mounted API routes as OpenAPI writes them: "METHOD /path", ":param" → "{param}". */
const mounted = (app) => listRoutes(app)
    .filter((r) => r.method !== 'ALL' && r.path.startsWith('/api'))
    .map((r) => `${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`)
    .filter((key) => !PROBES.has(key))
    .sort();

(async () => {
    const t = await boot();
    try {
        let doc = null;
        await check('/openapi.json is served as a cached JSON document', async () => {
            const r = await t.get('/openapi.json');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
            doc = r.json();
            assert.strictEqual(doc.openapi, '3.1.0');
            assert.ok(doc.paths && typeof doc.paths === 'object');
            assert.ok(Object.keys(doc.paths).length > 0, 'paths is not empty');
            assert.strictEqual(doc.info.title, 'OpenVibe.Community API');
            assert.deepStrictEqual(doc.servers, [{ url: 'https://openvibe.community' }]);
        });

        await check('every documented route is mounted, with an operationId and responses', async () => {
            const live = new Set(mounted(t.app));
            assert.ok(doc, 'the document was read');
            for (const [p, item] of Object.entries(doc.paths)) {
                assert.ok(p.startsWith('/api/'), `${p} is outside /api`);
                for (const [method, op] of Object.entries(item)) {
                    assert.ok(op.operationId, `${method.toUpperCase()} ${p} has an operationId`);
                    assert.ok(op.responses && Object.keys(op.responses).length, `${method.toUpperCase()} ${p} describes its responses`);
                    assert.ok(live.has(`${method.toUpperCase()} ${p}`), `${method.toUpperCase()} ${p} is documented but not mounted`);
                }
            }
        });

        await check('every mounted /api route is documented', async () => {
            const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort();
            assert.deepStrictEqual(mounted(t.app), documented);
            assert.deepStrictEqual(documented, routes(), 'server/openapi.js routes() and the document agree');
        });

        await check('/api/v1/openapi.json redirects to it', async () => {
            const r = await t.get('/api/v1/openapi.json');
            assert.strictEqual(r.status, 308);
            assert.strictEqual(r.headers.get('location'), '/openapi.json');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
