'use strict';
/** Boots the mocks, points the app at them, and returns a tiny HTTP client that keeps cookies. */
const http = require('http');
const mockLive = require('./mock-live');
const mockNetwork = require('./mock-network');
const mockMedia = require('./mock-media');

/**
 * opts.authority  'live' (default) or 'community' — the latter runs the native paste API on a
 *                 fresh in-memory database, with Network and Media mocks behind it.
 * opts.pasteLimits  overrides for service.js limits (e.g. { cooldownSeconds: 0 }).
 * opts.appOpts      passed through to createApp (commentLimits, forumLimits, relayOptions, …).
 */
async function boot(opts = {}) {
    const liveSrv = await mockLive.start();
    const netSrv = await mockNetwork.start();
    const mediaSrv = await mockMedia.start({ publicPem: netSrv.publicPem, issuer: netSrv.url });
    process.env.NODE_ENV = 'test';
    process.env.BASE_URL = 'https://openvibe.community';
    process.env.OV_LIVE_INTERNAL_URL = liveSrv.url;
    process.env.OV_LIVE_URL = 'https://openvibe.live';
    process.env.OV_MEDIA_URL = 'https://openvibe.media';
    process.env.OV_NETWORK_URL = netSrv.url;
    process.env.OV_NETWORK_INTERNAL_URL = netSrv.url;
    process.env.OV_OAUTH_CLIENT_ID = 'community';
    process.env.OV_OAUTH_CLIENT_SECRET = 'shh';
    process.env.OV_OAUTH_REDIRECT_URI = 'https://openvibe.community/auth/callback';
    process.env.COOKIE_SECURE = 'true';
    process.env.TRUST_PROXY = '1';
    process.env.OV_MEDIA_INTERNAL_URL = mediaSrv.url;
    process.env.PASTES_AUTHORITY = opts.authority || 'live';
    process.env.COMMUNITY_DB_PATH = ':memory:';
    for (const k of Object.keys(require.cache)) if (k.includes('/server/')) delete require.cache[k];
    const { createApp } = require('../../server/app');
    const appOpts = { ...(opts.appOpts || {}) };
    if (opts.authority === 'community') {
        appOpts.db = require('../../server/db').openDb(':memory:');
        appOpts.pasteLimits = opts.pasteLimits;
    }
    const app = createApp(appOpts);
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const jar = new Map();
    async function get(path, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).concat(opts.cookies || []);
        if (cookies.length) headers.cookie = cookies.join('; ');
        const res = await fetch(base + path, { method: opts.method || 'GET', headers, body: opts.body, redirect: 'manual', duplex: opts.body && typeof opts.body.pipe === 'function' ? 'half' : undefined });
        for (const sc of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
            const [pair, ...attrs] = sc.split(';');
            const [k, v] = pair.split('=');
            const expired = attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()));
            if (expired) jar.delete(k.trim()); else jar.set(k.trim(), v);
        }
        const text = await res.text();
        return { status: res.status, headers: res.headers, text, setCookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [], json() { return JSON.parse(text); } };
    }
    return {
        app, base, get, jar, live: liveSrv, network: netSrv, media: mediaSrv, db: appOpts.db || null,
        close: async () => { await new Promise((r) => server.close(r)); await liveSrv.close(); await netSrv.close(); await mediaSrv.close(); },
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 4).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done };
