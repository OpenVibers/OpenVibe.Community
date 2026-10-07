'use strict';
/** Community fetches configured Network, Media, Events and Search URLs, never a URL supplied in content. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

// file → [call sites, where they go and why the URL is not a user's]
const INVENTORY = {
    'server/app.js': [1, 'createAuthClient(config): the Network JWKS (OV_NETWORK_INTERNAL_URL)'],
    'server/auth/routes.js': [4, 'createAuthClient, JWKS, /oauth/token, /oauth/revoke: OV_NETWORK_INTERNAL_URL, fixed paths'],
    'server/events.js': [3, 'service token (Network) and the outbox publisher: EVENTS_URL'],
    'server/identity/network.js': [3, 'Network /internal/identity/resolve-batch and /internal/identity/resolve?username= with a service token (configured base, never a user URL)'],
    'server/render/pages.js': [1, 'not a call: the home page shows a fetch() sample as text (never executed)'],
    'server/identity/account-data.js': [2, 'Network /oauth/token and /internal/account-exports and /internal/account-deletions (fixed paths) with a service token'],
    'server/identity/profile-module.js': [3, 'Network modules API (community.profile) with a service token'],
    'server/media/files.js': [2, 'OV_MEDIA_INTERNAL_URL v1 file store, service token'],
    'server/media/objects.js': [2, 'OV_MEDIA_INTERNAL_URL Object API v2, service token'],
    'server/observability.js': [1, '/api/ready probes of the configured Media health URL'],
    'server/pulse/consumer.js': [2, 'Events subscriptions API (EVENTS_URL) with a service token'],
    'server/search/query.js': [1, 'OV_SEARCH_INTERNAL_URL /api/v1/search, the query in URLSearchParams'],
};
const PATTERNS = [
    /\b(?:fetch|fetchImpl)\s*\(/g, /\bhttps?\.(?:request|get)\s*\(/g, /\bnew\s+WebSocket\w*\s*\(/g, /\b(?:net|tls)\.(?:connect|createConnection)\s*\(/g,
    /\bdns\.\w+\s*\(/g, /\bchild_process\b/g, /\bundici\b/g, /\baxios\b/g, /\bpuppeteer\b|\bplaywright\b/g,
    /\b(?:createClient|createServiceTokenClient|createTokenClient|createEventsClient|createVipClient|createModulesClient|createAuthClient)\s*\(/g,
];

function inventory() {
    const root = path.join(__dirname, '..');
    const out = {};
    (function walk(dir) {
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (!p.endsWith('.js')) continue;
            const code = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
            let n = 0;
            for (const line of code) for (const re of PATTERNS) n += (line.match(re) || []).length;
            if (n) out[path.relative(root, p).split(path.sep).join('/')] = n;
        }
    })(path.join(root, 'server'));
    return out;
}

(async () => {
    await check('every outbound call site in server/ is in the classified inventory (a new one must be classified here)', async () => {
        const found = inventory();
        const problems = [];
        for (const [file, n] of Object.entries(found)) {
            if (!INVENTORY[file]) problems.push(`${file}: ${n} new outbound call site(s): classify them (where they go; is the URL a user's?)`);
            else if (INVENTORY[file][0] !== n) problems.push(`${file}: ${n} outbound call sites, inventory says ${INVENTORY[file][0]}: classify the change`);
        }
        for (const file of Object.keys(INVENTORY)) if (!found[file]) problems.push(`${file}: no outbound call left, drop it from the inventory`);
        assert.deepStrictEqual(problems, []);
    });

    // ── community mode: URLs people and services hand in are never fetched ──
    const hits = [];
    const canary = await new Promise((resolve) => {
        const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end('canary'); });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const C = `http://127.0.0.1:${canary.address().port}`;
    const t = await boot({
        authority: 'community',
        env: { OV_SEARCH_INTERNAL_URL: 'http://127.0.0.1:9' },
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
        },
    });
    const net = t.network;
    const u = net.addUser({ network_user_id: 51, username: 'ursula' });
    const boss = net.addUser({ network_user_id: 52, username: 'boss' });
    const jwt = net.sign({ id: 51, subject_id: u.subject_id, username: 'ursula', role: 'user' });
    const bossJwt = net.sign({ id: 52, subject_id: boss.subject_id, username: 'boss', role: 'admin' });
    const send = async (method, p, { cookie = jwt, token, json, body, headers = {} } = {}) => {
        const h = { ...headers };
        if (cookie && !token) h.cookie = `ov_token=${cookie}`;
        if (token) h.authorization = `Bearer ${token}`;
        if (json !== undefined) h['content-type'] = 'application/json';
        const res = await fetch(t.base + p, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, redirect: 'manual' });
        return { status: res.status, text: await res.text() };
    };

    await check('URLs people and services hand in (Pulse items, comments, pastes and page_url) are never fetched', async () => {
        const urls = [`${C}/pulse`, `${C}/post`, `${C}/img.png`, 'http://169.254.169.254/latest/meta-data/', `${C}/comment`, `${C}/paste`, `${C}/page`, `${C}/r/room-one`];
        const r1 = await send('POST', '/api/v1/pulse/items', { token: net.signService({ sub: 'svc:live', cap: ['community.pulse.write'] }), json: { ref: { service: 'live', type: 'stream', id: '5' }, title: 'live now', url: urls[0] } });
        assert.strictEqual(r1.status, 201, r1.text);
        const p = await send('POST', '/api/pastes', { json: { title: urls[5], content: `curl ${urls[5]}\n![x](${urls[2]})` } });
        assert.strictEqual(p.status, 201, p.text);
        assert.strictEqual((await send('GET', `/p/${JSON.parse(p.text).slug}`)).status, 200);
        await send('POST', `/api/pastes/${JSON.parse(p.text).slug}/comments`, { json: { message: `look ${urls[4]}` } });
        const f = new FormData();
        f.append('page_url', urls[6]);
        f.append('screenshot', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 's.png');
        assert.strictEqual((await send('POST', '/api/pastes/screenshot', { body: f })).status, 201);
        const cth = JSON.parse((await send('POST', '/api/v1/comments/threads/resolve', { json: { ref: { service: 'community', type: 'paste', id: JSON.parse(p.text).slug } } })).text).thread;
        await send('POST', `/api/v1/comments/threads/${cth.id}/comments`, { json: { message: `![x](${urls[2]}) ${urls[4]}` } });
        for (const page of ['/', '/pulse', '/api/v1/pulse', '/feed.xml', '/sitemap.xml']) await send('GET', page);
        await new Promise((r) => setTimeout(r, 200));
        assert.deepStrictEqual(hits, [], 'Community fetched a URL it was handed');
    });

    await t.close();
    await new Promise((r) => canary.close(r));
    done();
})();
