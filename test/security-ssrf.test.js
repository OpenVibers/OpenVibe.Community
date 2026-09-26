'use strict';
/**
 * SSRF (roadmap WS-R task 5). Community fetches no URL a user chooses: no link previews, unfurls,
 * avatar or image imports, user webhooks or screenshots of URLs. Every outbound call goes to a base URL
 * from the owner's environment (Network, Live, Media, Events, VIP, Chat, Search, a Discord webhook
 * variable the owner allowlisted, Discord's gateway), so there is no egress guard to test. Three things
 * keep it that way:
 *
 *   1. A ratchet over server/: every outbound call site (fetch, http(s).request/get, WebSocket, net/tls,
 *      dns, child_process, and the SDK clients that make requests) is counted per file and must match
 *      the classified inventory below. A new one fails this test until someone writes down where it goes
 *      and why the URL is not the user's (and, if it is, routes it through openvibe-shared/egress).
 *   2. Everywhere a person or a service can hand Community a URL (a Pulse item's url, links and image
 *      syntax in posts and comments, paste content, a screenshot's page_url, a chat room reference, a relay
 *      mapping), a canary server on loopback must never be called.
 *   3. PASTES_AUTHORITY=live proxies /api/pastes/* to Live with the visitor's path: dot segments
 *      ("/api/pastes/../../internal/x", also %2e%2e) and encoded slashes must not reach any other Live route.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

// file → [call sites, where they go and why the URL is not a user's]
const INVENTORY = {
    'server/app.js': [1, 'createAuthClient(config): the Network JWKS (OV_NETWORK_INTERNAL_URL)'],
    'server/auth/routes.js': [4, 'createAuthClient, JWKS, /oauth/token, /oauth/revoke: OV_NETWORK_INTERNAL_URL, fixed paths'],
    'server/chat-rooms.js': [1, 'OV_CHAT_INTERNAL_URL /api/chat/rooms/<slug>/attachments; the slug must match ROOM_SLUG and is encoded'],
    'server/events.js': [3, 'service token (Network) and the outbox publisher: EVENTS_URL'],
    'server/identity/network.js': [2, 'Network /internal/identity/resolve-batch with a service token'],
    'server/identity/profile-module.js': [3, 'Network modules API (community.profile) with a service token'],
    'server/live-client.js': [1, 'OV_LIVE_INTERNAL_URL/api + fixed paths; slugs encoded (callers check SLUG_RE)'],
    'server/media/files.js': [2, 'OV_MEDIA_INTERNAL_URL v1 file store, service token'],
    'server/media/objects.js': [2, 'OV_MEDIA_INTERNAL_URL Object API v2, service token'],
    'server/observability.js': [1, '/api/ready probes of the configured Live or Media health URL'],
    'server/pastes/proxy.js': [1, 'OV_LIVE_INTERNAL_URL/api/pastes + the visitor\'s path, which must stay under /api/pastes (tested below)'],
    'server/pulse/consumer.js': [2, 'Events subscriptions API (EVENTS_URL) with a service token'],
    'server/relay/discord-gateway.js': [1, 'DISCORD_GATEWAY_URL (owner) or the resume_gateway_url Discord\'s READY names'],
    'server/relay/discord.js': [1, 'a Discord webhook URL read from an environment variable the owner allowlisted; mappings name the variable, never a URL'],
    'server/relay/events-worker.js': [3, 'Events pull API (EVENTS_URL) with a service token'],
    'server/search/query.js': [1, 'OV_SEARCH_INTERNAL_URL /api/v1/search, the query in URLSearchParams'],
    'server/vip/index.js': [2, 'OV_VIP_INTERNAL_URL policy evaluate, service token'],
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

/** GET a raw path (no client-side normalisation of dot segments). */
function rawGet(base, rawPath) {
    const { port } = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
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

    // ── live mode: the /api/pastes proxy ──
    {
        const t = await boot({ appOpts: { startRelay: false } });
        await check('PASTES_AUTHORITY=live: the /api/pastes proxy never leaves Live\'s paste API (dot segments, %2e%2e, encoded slashes)', async () => {
            const bad = ['/api/pastes/../../internal/x', '/api/pastes/../x', '/api/pastes/%2e%2e/%2e%2e/internal/x', '/api/pastes/%2E%2E/%2E%2E/metrics', '/api/pastes/.%2e/.%2e/internal/x',
                '/api/pastes/..%2f..%2finternal/x', '/api/pastes/..%2F..%2Finternal/x', '/api/pastes/..%5c..%5cinternal', '/api/pastes/amber-fox-42/../../../internal/x',
                '/api/pastes/./../../internal/x?next=1'];
            for (const p of bad) {
                const before = t.live.calls.length;
                const r = await rawGet(t.base, p);
                const reached = t.live.calls.slice(before).map((c) => c.path);
                assert.ok(reached.every((x) => x === '/api/pastes' || x.startsWith('/api/pastes/')), `${p} reached Live at ${reached.join(', ')}`);
                assert.ok(!reached.some((x) => /internal|metrics|%2f|%5c/i.test(x)), `${p} reached Live at ${reached.join(', ')}`);
                assert.strictEqual(r.status, 404, `${p}: ${r.status}`);
            }
            // Positive controls: the paste API itself still goes through.
            let before = t.live.calls.length;
            assert.strictEqual((await rawGet(t.base, '/api/pastes/amber-fox-42')).status, 200);
            assert.deepStrictEqual(t.live.calls.slice(before).map((c) => c.path), ['/api/pastes/amber-fox-42']);
            before = t.live.calls.length;
            assert.strictEqual((await rawGet(t.base, '/api/pastes?limit=1')).status, 200);
            const listed = t.live.calls.slice(before).map((c) => c.path);
            assert.ok(listed.length === 1 && /^\/api\/pastes\/?$/.test(listed[0]), listed.join(', '));
        });
        await t.close();
    }

    // ── community mode: URLs people and services hand in are never fetched ──
    const hits = [];
    const canary = await new Promise((resolve) => {
        const s = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end('canary'); });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const C = `http://127.0.0.1:${canary.address().port}`;
    const t = await boot({
        authority: 'community',
        env: { OV_CHAT_INTERNAL_URL: 'http://127.0.0.1:9', OV_VIP_INTERNAL_URL: 'http://127.0.0.1:9', OV_SEARCH_INTERNAL_URL: 'http://127.0.0.1:9' },
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            startRelay: false,
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 },
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

    await check('URLs people and services hand in (Pulse items, post links and images, comments, pastes, page_url, chat rooms, relay mappings) are never fetched', async () => {
        const urls = [`${C}/pulse`, `${C}/post`, `${C}/img.png`, 'http://169.254.169.254/latest/meta-data/', `${C}/comment`, `${C}/paste`, `${C}/page`, `${C}/r/room-one`];
        const r1 = await send('POST', '/api/v1/pulse/items', { token: net.signService({ sub: 'svc:live', cap: ['community.pulse.write'] }), json: { ref: { service: 'live', type: 'stream', id: '5' }, title: 'live now', url: urls[0] } });
        assert.strictEqual(r1.status, 201, r1.text);
        const th = await send('POST', '/api/v1/spaces/general/threads', { json: { title: 'links', body: `see [this](${urls[1]}) and ![img](${urls[2]}) and <img src="${urls[3]}"> ${urls[1]}` } });
        assert.strictEqual(th.status, 201, th.text);
        const slug = JSON.parse(th.text).thread.slug;
        assert.strictEqual((await send('GET', `/s/general/t/${slug}`)).status, 200);
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
        t.db.prepare("UPDATE spaces SET created_by = ? WHERE slug = 'general'").run(u.subject_id);
        await send('PUT', '/api/v1/spaces/general/chat-room', { json: { room: urls[7] } });
        const map = await send('POST', '/api/v1/relay/mappings', { cookie: bossJwt, json: { space: 'general', webhook_url_ref: `${C}/hook` } });
        assert.strictEqual(map.status, 400, 'a mapping names a variable, never a URL');
        for (const page of ['/', '/pulse', '/api/v1/pulse', '/s/general', '/feed.xml', '/s/feed.xml', '/sitemap.xml']) await send('GET', page);
        await new Promise((r) => setTimeout(r, 200));
        assert.deepStrictEqual(hits, [], 'Community fetched a URL it was handed');
    });

    await t.close();
    await new Promise((r) => canary.close(r));
    done();
})();
