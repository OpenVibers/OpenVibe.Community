// ═══════════════════════════════════════════════════════════════
// navbar.js — SSO auth resolution tests (plain node, no browser)
// Covers: ov_token cookie parsing, host branching (network vs tools
// apex/gateway/satellite), sign-in link resolution, and the async
// user-resolution flow (me → gateway refresh → network grace refresh)
// using stubbed document/location/localStorage/fetch globals.
// ═══════════════════════════════════════════════════════════════

'use strict';

const assert = require('assert');
const path = require('path');

const NAVBAR_PATH = path.join(__dirname, '..', 'navbar.js');

function stubElement() {
    return {
        style: {},
        textContent: '',
        className: '',
        id: '',
        innerHTML: '',
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {},
        prepend() {},
        remove() {},
        addEventListener() {},
        querySelector() { return stubElement(); },
        querySelectorAll() { return []; },
    };
}

/**
 * Build a fresh browser-ish environment and load navbar.js into it.
 * @param {Object} opts
 * @param {string} opts.hostname   - location.hostname
 * @param {string} [opts.href]     - location.href
 * @param {string} [opts.cookie]   - document.cookie contents
 * @param {Object} [opts.storage]  - initial localStorage entries
 * @param {Function} [opts.fetch]  - fetch stub
 */
function loadNavbar(opts) {
    const calls = [];
    global.location = {
        hostname: opts.hostname,
        href: opts.href || `https://${opts.hostname}/`,
        protocol: 'https:',
    };
    global.window = { location: global.location };
    global.document = {
        cookie: opts.cookie || '',
        head: stubElement(),
        body: stubElement(),
        getElementById: () => null,
        createElement: () => stubElement(),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {},
    };
    global.CustomEvent = class CustomEvent {
        constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    };
    const store = { ...(opts.storage || {}) };
    global.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        _store: store,
    };
    global.fetch = async (url, init) => {
        calls.push({ url, init: init || {} });
        if (opts.fetch) return opts.fetch(url, init || {});
        return { ok: false, status: 404, json: async () => ({}) };
    };

    delete require.cache[require.resolve(NAVBAR_PATH)];
    const navbar = require(NAVBAR_PATH);
    return { navbar, calls, storage: global.localStorage };
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const USER = { id: 7, username: 'vibe', display_name: 'Vibe', avatar_url: null, role: 'user' };

(async () => {
    // ── 1. Cookie parsing ────────────────────────────────────
    {
        const { navbar } = loadNavbar({ hostname: 'openvibe.network' });
        const p = navbar._auth.parseCookieToken;
        assert.strictEqual(p('ov_token=abc123'), 'abc123');
        assert.strictEqual(p('theme=dark; ov_token=abc123; other=1'), 'abc123');
        assert.strictEqual(p('prefix_ov_token=nope; ov_token=real'), 'real');
        assert.strictEqual(p('ov_token=a%2Fb'), 'a/b');
        assert.strictEqual(p('ov_token='), null);
        assert.strictEqual(p('other=1'), null);
        assert.strictEqual(p(''), null);
    }

    // ── 2. Host branching ────────────────────────────────────
    {
        const { navbar } = loadNavbar({ hostname: 'openvibe.network' });
        const a = navbar._auth;
        assert.strictEqual(a.onToolsDomain('openvibe.tools'), true);
        assert.strictEqual(a.onToolsDomain('net.openvibe.tools'), true);
        assert.strictEqual(a.onToolsDomain('maps.openvibe.tools'), true);
        assert.strictEqual(a.onToolsDomain('mergepdf.openvibe.tools'), true);
        assert.strictEqual(a.onToolsDomain('openvibe.network'), false);
        assert.strictEqual(a.onToolsDomain('openvibe.live'), false);
        assert.strictEqual(a.onToolsDomain('evilopenvibe.tools'), false);
        assert.strictEqual(a.onNetworkDomain('openvibe.network'), true);
        assert.strictEqual(a.onNetworkDomain('net.openvibe.tools'), false);
    }

    // ── 3. Sign-in link resolution ───────────────────────────
    {
        const { navbar } = loadNavbar({ hostname: 'openvibe.network' });
        const a = navbar._auth;
        const ret = 'https://net.openvibe.tools/?q=8.8.8.8';
        const enc = encodeURIComponent(ret);
        // Any tools host — gateway subdomain, satellite, or apex — signs in
        // through the gateway apex (sets the Domain=.openvibe.tools cookie).
        assert.strictEqual(a.resolveLoginHref('net.openvibe.tools', ret), `https://openvibe.tools/auth/login?next=${enc}`);
        assert.strictEqual(a.resolveLoginHref('maps.openvibe.tools', ret), `https://openvibe.tools/auth/login?next=${enc}`);
        assert.strictEqual(a.resolveLoginHref('openvibe.tools', ret), `https://openvibe.tools/auth/login?next=${enc}`);
        // Network host uses its own login page.
        assert.strictEqual(a.resolveLoginHref('openvibe.network', ret), `/login?return=${enc}`);
        // Anything else (live, games, localhost) keeps the legacy behavior.
        assert.strictEqual(a.resolveLoginHref('openvibe.live', ret), `https://openvibe.network/login?return=${enc}`);
        assert.strictEqual(a.resolveLoginHref('localhost', ret), `https://openvibe.network/login?return=${enc}`);
    }

    // ── 4. loginUrl override hook ────────────────────────────
    {
        const { navbar } = loadNavbar({ hostname: 'maps.openvibe.tools' });
        navbar.init({ service: 'maps', loginUrl: '/custom-login' });
        assert.strictEqual(navbar._auth.resolveLoginHref('maps.openvibe.tools', 'https://x/'), '/custom-login');
    }

    // ── 5. Valid cookie token → user chip (the reported bug) ─
    {
        const { navbar, calls } = loadNavbar({
            hostname: 'net.openvibe.tools',
            href: 'https://net.openvibe.tools/?q=8.8.8.8',
            cookie: 'ov_token=valid-jwt',
            fetch: async (url, init) => {
                if (url === 'https://openvibe.network/api/auth/me') {
                    assert.strictEqual(init.headers.Authorization, 'Bearer valid-jwt');
                    return jsonResponse(200, { user: USER, preferences: { theme_id: 'vibe' } });
                }
                return jsonResponse(404, {});
            },
        });
        // Mirrors net.html: token passed, user NOT passed.
        navbar.init({ service: 'net', apiBase: 'https://openvibe.network', token: 'valid-jwt' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user.username, 'vibe');
        assert.ok(navbar.getElement().innerHTML.includes('openvibe-navbar-avatar'), 'renders the avatar chip');
        assert.ok(!navbar.getElement().innerHTML.includes('openvibe-navbar-login'), 'no Sign In button');
        assert.strictEqual(calls.length, 1, 'exactly one auth call');
    }

    // ── 6. No token, no sessionUrl → signed out, zero fetches ─
    {
        const { navbar, calls } = loadNavbar({ hostname: 'maps.openvibe.tools' });
        navbar.init({ service: 'maps', apiBase: 'https://openvibe.network' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user, null);
        assert.strictEqual(calls.length, 0, 'anonymous visits make no auth traffic');
        const html = navbar.getElement().innerHTML;
        assert.ok(html.includes('https://openvibe.tools/auth/login?next='), 'Sign In goes through the gateway apex');
    }

    // ── 7. Expired token on a gateway host → same-origin refresh ─
    {
        const { navbar, storage } = loadNavbar({
            hostname: 'openvibe.tools',
            cookie: 'ov_token=expired-jwt',
            fetch: async (url, init) => {
                if (url === 'https://openvibe.network/api/auth/me') {
                    return init.headers.Authorization === 'Bearer fresh-jwt'
                        ? jsonResponse(200, { user: USER })
                        : jsonResponse(401, { error: 'Invalid or expired token' });
                }
                if (url === '/auth/refresh') return jsonResponse(200, { token: 'fresh-jwt', user: USER });
                return jsonResponse(404, {});
            },
        });
        navbar.init({ service: 'tools', apiBase: 'https://openvibe.network' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user.username, 'vibe');
        assert.strictEqual(storage.getItem('ov_token'), 'fresh-jwt', 'refreshed token persisted');
        assert.ok(global.document.cookie.includes('ov_token=fresh-jwt'), 'cookie updated');
        assert.ok(global.document.cookie.includes('domain=.openvibe.tools'), 'cookie scoped to .openvibe.tools');
    }

    // ── 8. Expired token on a satellite → Network grace refresh ─
    // Satellites do not mount /auth/refresh (404) — the Network's
    // 7-day-grace POST /api/auth/refresh recovers the session.
    {
        const { navbar, storage } = loadNavbar({
            hostname: 'maps.openvibe.tools',
            cookie: 'ov_token=expired-jwt',
            fetch: async (url, init) => {
                if (url === 'https://openvibe.network/api/auth/me') {
                    return init.headers.Authorization === 'Bearer graced-jwt'
                        ? jsonResponse(200, { user: USER })
                        : jsonResponse(401, {});
                }
                if (url === '/auth/refresh') return jsonResponse(404, {}); // satellite: no gateway routes
                if (url === 'https://openvibe.network/api/auth/refresh') {
                    assert.strictEqual(init.headers.Authorization, 'Bearer expired-jwt');
                    return jsonResponse(200, { token: 'graced-jwt', user: USER });
                }
                return jsonResponse(404, {});
            },
        });
        navbar.init({ service: 'maps', apiBase: 'https://openvibe.network' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user.username, 'vibe');
        assert.strictEqual(storage.getItem('ov_token'), 'graced-jwt');
        assert.ok(global.document.cookie.includes('domain=.openvibe.tools'));
    }

    // ── 9. Token dead beyond recovery → signed out ───────────
    {
        const { navbar } = loadNavbar({
            hostname: 'net.openvibe.tools',
            cookie: 'ov_token=dead-jwt',
            fetch: async (url) => {
                if (url === 'https://openvibe.network/api/auth/me') return jsonResponse(401, {});
                return jsonResponse(401, {});
            },
        });
        navbar.init({ service: 'net', apiBase: 'https://openvibe.network' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user, null);
        assert.ok(navbar.getElement().innerHTML.includes('openvibe-navbar-login'), 'renders signed-out');
    }

    // ── 10. localStorage fallback when no cookie ─────────────
    {
        const { navbar } = loadNavbar({
            hostname: 'openvibe.network',
            storage: { ov_token: 'ls-jwt' },
            fetch: async (url, init) => {
                if (url === 'https://openvibe.network/api/auth/me') {
                    assert.strictEqual(init.headers.Authorization, 'Bearer ls-jwt');
                    return jsonResponse(200, { user: USER });
                }
                return jsonResponse(404, {});
            },
        });
        navbar.init({ service: 'network', apiBase: 'https://openvibe.network' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user.username, 'vibe');
    }

    // ── 11. Cookie wins over stale localStorage ──────────────
    {
        const { navbar } = loadNavbar({
            hostname: 'net.openvibe.tools',
            cookie: 'ov_token=cookie-jwt',
            storage: { ov_token: 'stale-ls-jwt' },
        });
        assert.strictEqual(navbar._auth.resolveToken(), 'cookie-jwt');
    }

    // ── 12. sessionUrl hook (app-specific session, no token) ─
    {
        const { navbar } = loadNavbar({
            hostname: 'openvibe.live',
            fetch: async (url) => {
                if (url === '/api/session') return jsonResponse(200, { user: USER });
                return jsonResponse(404, {});
            },
        });
        navbar.init({ service: 'live', apiBase: 'https://openvibe.network', sessionUrl: '/api/session' });
        const user = await navbar.refreshAuth();
        assert.strictEqual(user.username, 'vibe');
    }

    // ── 13. Explicit user passed → no auth traffic at all ────
    {
        const { navbar, calls } = loadNavbar({
            hostname: 'openvibe.network',
            cookie: 'ov_token=whatever',
        });
        navbar.init({ service: 'network', token: 'whatever', user: USER });
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(calls.length, 0, 'pages that pass a user keep full control');
        assert.ok(navbar.getElement().innerHTML.includes('openvibe-navbar-avatar'));
    }

    console.log('navbar-auth: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
