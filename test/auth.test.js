'use strict';
/** The OAuth client: login (incl. silent), callback, logout, me, refresh, and next sanitising. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();
    const cookieNamed = (r, name) => r.setCookies.find((c) => c.startsWith(`${name}=`));

    await check('GET /auth/login builds the Network authorize URL and sets the state cookie', async () => {
        const r = await t.get('/auth/login?next=/pastes%3Fsort%3Dviews');
        assert.strictEqual(r.status, 302);
        const u = new URL(r.headers.get('location'));
        assert.strictEqual(u.origin, t.network.url);
        assert.strictEqual(u.pathname, '/oauth/authorize');
        assert.strictEqual(u.searchParams.get('client_id'), 'community');
        assert.strictEqual(u.searchParams.get('redirect_uri'), 'https://openvibe.community/auth/callback');
        assert.strictEqual(u.searchParams.get('response_type'), 'code');
        assert.strictEqual(u.searchParams.get('scope'), 'profile theme');
        assert.strictEqual(u.searchParams.get('prompt'), null);
        assert.ok(/^[0-9a-f]{32}$/.test(u.searchParams.get('state')));
        const state = cookieNamed(r, 'ov_oauth_state');
        assert.ok(state && /HttpOnly/i.test(state) && /Path=\/auth/.test(state) && /Secure/.test(state) && !/Domain=/i.test(state), 'state cookie: httpOnly, /auth, secure, host-only');
        assert.ok(state.includes(u.searchParams.get('state')));
        assert.strictEqual(decodeURIComponent(cookieNamed(r, 'ov_oauth_next').split(';')[0].split('=').slice(1).join('=')), '/pastes?sort=views');
    });

    await check('silent=1 adds prompt=none; login_required bounces back to next + ?sso=none', async () => {
        const r = await t.get('/auth/login?silent=1&next=/p/amber-fox-42');
        const u = new URL(r.headers.get('location'));
        assert.strictEqual(u.searchParams.get('prompt'), 'none');
        assert.ok(cookieNamed(r, 'ov_oauth_silent'));
        const back = await t.get(`/auth/callback?error=login_required&state=${u.searchParams.get('state')}`);
        assert.strictEqual(back.status, 302);
        assert.strictEqual(back.headers.get('location'), '/p/amber-fox-42?sso=none');
        assert.ok(!t.jar.has('ov_token'), 'no session was created');
    });

    await check('?sso=none is appended correctly to a next that already has a query or a Network URL', async () => {
        const { withParam, sanitizeNext } = require('../server/auth/routes');
        const cfg = require('../server/config');
        assert.strictEqual(withParam('/pastes?sort=views', 'sso', 'none'), '/pastes?sort=views&sso=none');
        assert.strictEqual(withParam('/pastes#x', 'sso', 'none'), '/pastes?sso=none#x');
        assert.strictEqual(sanitizeNext('/my', cfg), '/my');
        assert.strictEqual(sanitizeNext('//evil.example/x', cfg), '/');
        assert.strictEqual(sanitizeNext('https://evil.example/x', cfg), '/');
        assert.strictEqual(sanitizeNext('https://openvibe.community/pastes', cfg), 'https://openvibe.community/pastes');
        assert.strictEqual(sanitizeNext(`${t.network.url}/sso/next?step=2`.replace(/^http:/, 'https:'), cfg), `${t.network.url}/sso/next?step=2`.replace(/^http:/, 'https:'));
        assert.strictEqual(sanitizeNext('javascript:alert(1)', cfg), '/');
    });

    await check('callback exchanges the code, sets host-only ov_token (JS-readable) + ov_refresh + ov_sso_hint=account, redirects to next', async () => {
        const login = await t.get('/auth/login?next=/my');
        const state = new URL(login.headers.get('location')).searchParams.get('state');
        const cb = await t.get(`/auth/callback?code=good-code&state=${state}`);
        assert.strictEqual(cb.status, 302, cb.text);
        assert.strictEqual(cb.headers.get('location'), '/my');
        const tok = cookieNamed(cb, 'ov_token');
        assert.ok(tok && !/HttpOnly/i.test(tok) && /SameSite=Lax/i.test(tok) && /Secure/.test(tok) && !/Domain=/i.test(tok) && /Path=\//.test(tok));
        const ref = cookieNamed(cb, 'ov_refresh');
        assert.ok(ref && /HttpOnly/i.test(ref) && /Path=\/auth/.test(ref));
        const hint = cookieNamed(cb, 'ov_sso_hint');
        assert.ok(hint && hint.startsWith('ov_sso_hint=account') && !/HttpOnly/i.test(hint) && /Max-Age=31536000/.test(hint));
        const grant = t.network.grants.pop();
        assert.strictEqual(grant.grant_type, 'authorization_code');
        assert.strictEqual(grant.client_id, 'community');
        assert.strictEqual(grant.redirect_uri, 'https://openvibe.community/auth/callback');
    });

    await check('/auth/me verifies the cookie offline via the Network JWKS', async () => {
        const me = await t.get('/auth/me');
        assert.strictEqual(me.status, 200);
        const body = me.json();
        assert.strictEqual(body.user.username, 'alex');
        assert.strictEqual(body.user.exp, undefined);
        assert.ok(body.expires_at > Date.now());
        const bad = await t.get('/auth/me', { cookies: ['ov_token=garbage'], headers: { authorization: 'Bearer garbage' } });
        assert.strictEqual(bad.status, 401);
    });

    await check('callback rejects a missing or mismatched state', async () => {
        const r = await t.get('/auth/callback?code=good-code&state=deadbeef');
        assert.strictEqual(r.status, 400);
    });

    await check('POST /auth/refresh rotates tokens; a rejected refresh clears the session', async () => {
        t.jar.set('ov_refresh', 'refresh-1');
        const ok = await t.get('/auth/refresh', { method: 'POST' });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.json().user.username, 'alex');
        assert.strictEqual(t.jar.get('ov_refresh'), 'refresh-2');
        t.jar.set('ov_refresh', 'stale');
        const no = await t.get('/auth/refresh', { method: 'POST' });
        assert.strictEqual(no.status, 401);
        assert.ok(!t.jar.has('ov_token'));
    });

    await check('logout clears the session, sets ov_sso_hint=guest and honours a Network next', async () => {
        t.jar.set('ov_token', 'x'); t.jar.set('ov_refresh', 'refresh-2');
        const next = `${t.network.url}/logout?everywhere=1`.replace(/^http:/, 'https:');
        const r = await t.get(`/auth/logout?next=${encodeURIComponent(next)}`);
        assert.strictEqual(r.status, 302);
        assert.strictEqual(r.headers.get('location'), next);
        assert.ok(cookieNamed(r, 'ov_sso_hint').startsWith('ov_sso_hint=guest'));
        assert.ok(!t.jar.has('ov_token') && !t.jar.has('ov_refresh'));
        const evil = await t.get('/auth/logout?next=https://evil.example/');
        assert.strictEqual(evil.headers.get('location'), '/');
    });

    await t.close();
    done();
})();
