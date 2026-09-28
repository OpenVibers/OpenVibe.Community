'use strict';
/**
 * Internal secrets never leave the server (roadmap WS-R task 5: internal-secret leak).
 *
 * Every secret Community reads is set to an obviously fake, low-entropy sentinel
 * (sentinel-not-a-secret-<name>): the OAuth client secret (service tokens, sign-in, the view hash
 * fallback), the Events delivery secrets (a comma list), VIEW_HASH_SECRET, the Discord bot token and a
 * Discord webhook URL (named by DISCORD_RELAY_WEBHOOK_VARS). Positive controls show each one is really
 * in use (the Network mock only grants with the sentinel client secret; the webhook stub is called at
 * the sentinel URL; a delivery signed with the sentinel is accepted; anonymous views are keyed by an
 * HMAC under VIEW_HASH_SECRET). Then every GET route Express knows after boot (read from the router
 * stack, so a route added later is crawled too) is requested with seeded ids, nonsense ids and a query
 * string, as anonymous, a user, an admin and a staff service; plus error paths (unknown routes, bad
 * ids, malformed JSON, bad and expired credentials, refused writes, sign-in failures, bad event
 * signatures), /api/ready, /metrics, /release.json and the staff relay reads. No response body or
 * header may carry a sentinel (raw, hex, base64 at any alignment) or a service token the Network mock
 * issued to Community; neither may the events outbox, the relay's recorded errors, or anything the
 * process logged while serving.
 */
const assert = require('assert');
const crypto = require('crypto');

// Everything the process writes from here on (console included) is checked for sentinels at the end.
let logged = '';
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => { logged += String(chunk); return write(chunk, ...rest); };
}

const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/app');
const { listRoutes, fill } = require('./helpers/routes');

const S = (name) => `sentinel-not-a-secret-${name}`;
const EVENTS_SECRETS = [S('events-current-aaaaaaaaaaaaaaaa'), S('events-previous-aaaaaaaaaaaaaaa')];   // ≥ 32 characters each
const WEBHOOK = `https://discord.test/api/webhooks/123456789012345678/${S('discord-webhook')}`;
const SECRET_ENV = {
    OV_OAUTH_CLIENT_SECRET: S('oauth-client'),
    COMMUNITY_EVENTS_SECRET: EVENTS_SECRETS.join(','),
    VIEW_HASH_SECRET: S('view-hash'),
    DISCORD_BOT_TOKEN: S('discord-bot'),
    DISCORD_WEBHOOK_GENERAL: WEBHOOK,
};
const ENV = {
    ...SECRET_ENV,
    DISCORD_RELAY_ENABLED: 'on', DISCORD_RELAY_WEBHOOK_VARS: 'DISCORD_WEBHOOK_GENERAL', DISCORD_RELAY_EVENTS: 'off',
    DISCORD_RELAY_INBOUND: 'on', DISCORD_GATEWAY_URL: 'ws://127.0.0.1:9/',
    // Nothing listens on port 9: Events, VIP, Chat and Search are down, so nothing leaves the machine.
    EVENTS_URL: 'http://127.0.0.1:9', OV_VIP_INTERNAL_URL: 'http://127.0.0.1:9', OV_CHAT_INTERNAL_URL: 'http://127.0.0.1:9', OV_SEARCH_INTERNAL_URL: 'http://127.0.0.1:9',
};

/** The forms a secret could leak in: as is, hex, and base64/base64url at each of the three alignments. */
function formsOf(value) {
    const out = new Set([value, encodeURIComponent(value), Buffer.from(value).toString('hex')]);
    for (let k = 0; k < 3; k++) {
        const b = Buffer.from('x'.repeat(k) + value).toString('base64');
        const mid = b.slice(k ? 4 : 0, -4);
        if (mid.length >= 12) { out.add(mid); out.add(mid.replace(/\+/g, '-').replace(/\//g, '_')); }
    }
    return [...out];
}

(async () => {
    const webhookCalls = [];
    const t = await boot({
        authority: 'community',
        env: ENV,
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            startRelay: false,
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 },
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
            // Discord's real answer for a webhook that no longer exists.
            relayOptions: {
                fetchImpl: async (url) => {
                    webhookCalls.push(String(url));
                    return new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404, headers: { 'content-type': 'application/json' } });
                },
            },
        },
    });
    const net = t.network;
    // The outbox keeps what it would publish (Events is down): event payloads are checked too.
    require('../server/events').init(t.db, { eventsUrl: ENV.EVENTS_URL, clientSecret: ENV.OV_OAUTH_CLIENT_SECRET, intervalMs: 3_600_000, fetchImpl: async () => { throw new Error('offline'); } });

    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const root = net.addUser({ network_user_id: 8, username: 'root', display_name: 'Root' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const rootJwt = net.sign({ id: 8, subject_id: root.subject_id, username: 'root', display_name: 'Root', role: 'admin' });
    const CAPS = ['community.paste.create', 'community.paste.write', 'community.paste.moderate', 'community.comment.write', 'community.comment.moderate', 'community.post.create', 'community.pulse.write'];
    const svcToken = net.signService({ sub: 'svc:live', cap: CAPS });

    let ipN = 0;
    /** One request; each from its own address (rate limits), except the loopback-only routes. */
    async function send(method, path, { cookie, token, headers = {}, json, body, direct = false } = {}) {
        const h = { ...headers };
        if (!direct) h['x-forwarded-for'] = `198.51.100.${(ipN++ % 250) + 1}`;
        if (cookie) h.cookie = [].concat(cookie).join('; ');
        if (token) h.authorization = `Bearer ${token}`;
        let payload = body;
        if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
        const res = await fetch(t.base + path, { method, headers: h, body: payload, redirect: 'manual' });
        return { status: res.status, headers: res.headers, text: await res.text() };
    }
    const personas = {
        anonymous: {},
        user: { cookie: `ov_token=${alexJwt}` },
        admin: { cookie: `ov_token=${rootJwt}` },
        service: { token: svcToken, headers: { 'x-ov-subject': alex.subject_id, 'x-ov-staff': '1' } },
    };

    // ── seed: something behind every id a route can take ──
    const created = async (r, what) => { assert.ok(r.status === 200 || r.status === 201, `${what}: ${r.status} ${r.text.slice(0, 200)}`); return JSON.parse(r.text); };
    const mapping = await created(await send('POST', '/api/v1/relay/mappings', { ...personas.admin, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } }), 'relay mapping');
    const pub = await created(await send('POST', '/api/pastes', { ...personas.user, json: { title: 'Public words', content: 'hello world, public' } }), 'public paste');
    const priv = await created(await send('POST', '/api/pastes', { ...personas.user, json: { title: 'Private words', content: 'private text', visibility: 'private' } }), 'private paste');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('title', 'A screenshot');
    form.append('screenshot', new Blob([png], { type: 'image/png' }), 'shot.png');
    const shot = await created(await send('POST', '/api/pastes/screenshot', { ...personas.user, body: form }), 'screenshot paste');
    const pasteComment = await created(await send('POST', `/api/pastes/${pub.slug}/comments`, { ...personas.user, json: { message: 'a paste comment' } }), 'paste comment');
    const thread = await created(await send('POST', '/api/v1/spaces/general/threads', { ...personas.user, json: { title: 'A thread', body: 'thread body' } }), 'thread');
    await created(await send('POST', `/api/v1/spaces/general/threads/${thread.thread.slug}/posts`, { ...personas.admin, json: { body: 'a reply' } }), 'reply');
    const cthread = await created(await send('POST', '/api/v1/comments/threads/resolve', { token: svcToken, json: { ref: { service: 'live', type: 'vod', id: '42' } } }), 'comment thread');
    const comment = await created(await send('POST', `/api/v1/comments/threads/${cthread.thread.id}/comments`, { ...personas.service, json: { message: 'a vod comment' } }), 'comment');
    const browserThread = await created(await send('POST', '/api/v1/comments/threads/resolve', { ...personas.user, json: { ref: { service: 'community', type: 'paste', id: pub.slug } } }), 'browser comment thread');
    await send('GET', `/api/pastes/${pub.slug}`, { headers: { 'x-forwarded-for': '203.0.113.9' }, direct: true });   // an anonymous view
    await t.app.locals.relay.drain();
    require('../server/search/documents').createSearchDocuments({ db: t.db }).scan();

    // ── positive controls: each secret is really in use ──
    await check('the sentinels are the secrets in use (grants, webhook, event signatures, view hash)', async () => {
        assert.ok(net.grants.some((g) => g.grant_type === 'client_credentials' && g.client_secret === ENV.OV_OAUTH_CLIENT_SECRET), 'Community got a service token with the sentinel client secret');
        assert.ok(net.issued.length > 0, 'the Network mock issued service tokens');
        assert.deepStrictEqual(webhookCalls.map((u) => u.split('?')[0]), [WEBHOOK], 'the relay posted to the sentinel webhook URL');
        const event = { event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN01', event_type: 'network.user.token_valid_after', version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
            subject: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, actor: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' },
            payload: { subject: { type: 'user', id: 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ' }, valid_after: new Date(Date.now() - 60_000).toISOString(), reason: 'signed_out_everywhere' } };
        for (const secret of EVENTS_SECRETS) {
            const body = JSON.stringify({ event, seq: 1 });
            const r = await send('POST', '/internal/events', { direct: true, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret) }, body });
            assert.strictEqual(r.status, 200, `a delivery signed with ${secret === EVENTS_SECRETS[0] ? 'the current' : 'the previous'} secret: ${r.text}`);
        }
        const visitor = `ip:${crypto.createHmac('sha256', ENV.VIEW_HASH_SECRET).update('203.0.113.9').digest('hex').slice(0, 32)}`;
        assert.ok(await t.db.prepare('SELECT 1 FROM paste_visits WHERE visitor = ?').get(visitor), 'anonymous views are keyed by an HMAC under VIEW_HASH_SECRET');
    });

    // What must never come back.
    const forbidden = [];
    for (const [name, value] of Object.entries(SECRET_ENV)) for (const v of value.split(',')) for (const f of formsOf(v)) forbidden.push({ name, value: f });
    for (const f of formsOf('sentinel-not-a-secret')) forbidden.push({ name: 'a sentinel', value: f });
    for (const tok of net.issued) { forbidden.push({ name: 'a service token Community holds', value: tok }); forbidden.push({ name: 'a service token signature', value: tok.split('.')[2] }); }
    const leaksIn = (text) => [...new Set(forbidden.filter((f) => text.includes(f.value)).map((f) => f.name))];
    const problems = [];
    let requests = 0;
    function inspect(label, r) {
        requests++;
        const headers = [...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
        let decoded = r.text;
        try { decoded = decodeURIComponent(r.text); } catch { /* not URL-encoded */ }
        const found = leaksIn(`${r.text}\n${decoded}\n${headers}`);
        if (found.length) problems.push(`${label} (${r.status}) → ${found.join(', ')}`);
    }

    // ── crawl every GET route ──
    const routes = listRoutes(t.app);
    const gets = routes.filter((r) => r.method === 'GET' || r.method === 'ALL');
    const values = {
        slug: [pub.slug, priv.slug, shot.slug, thread.thread.slug, 'zz-no-such-1'],
        space: ['general', 'no-such-space'],
        username: ['alex', 'nobody-here'],
        id: [String(thread.post.id), cthread.thread.access_id, String(cthread.thread.id), String(mapping.mapping.id), '999999999'],
        accessId: [browserThread.thread.id, `cth_${'A'.repeat(22)}`],
        commentId: [String(pasteComment.comment.id), String(comment.comment.id), '999999999'],
        category: ['no-such-category'], group: ['no-such-group'], service: ['community'], type: ['paste'],
        '*': ['x'],
    };
    const QUERY = `?limit=5&page=2&sort=new&q=world&search=world&type=paste&include_unlisted=1&needs_ai=1&status=failed&next=%2Fmy&fork=${priv.slug}&after=zz&cursor=zz&origin=user`;

    await check(`every GET route (${gets.length}, from the router stack) as anonymous, a user, an admin and a staff service: no secret in any answer`, async () => {
        assert.ok(gets.length >= 50, `only ${gets.length} GET routes found: the router walk is broken`);
        for (const r of gets) {
            for (const path of fill(r.path, values)) {
                for (const [who, p] of Object.entries(personas)) {
                    for (const q of ['', QUERY]) {
                        const direct = r.path === '/metrics';
                        inspect(`GET ${path}${q ? ' ?query' : ''} as ${who}`, await send('GET', path + q, { ...p, direct }));
                    }
                }
            }
        }
        if (problems.length) console.log(`    ${problems.slice(0, 60).join('\n    ')}`);
        assert.deepStrictEqual(problems, []);
    });

    await check('error paths: unknown routes, bad ids, malformed JSON, bad credentials, refused writes, failed sign-in, bad event signatures', async () => {
        const expiredJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', role: 'user' }, { expiresIn: -60 });
        const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        const bad = {
            garbage: { token: 'not-a-jwt' },
            expired: { cookie: `ov_token=${expiredJwt}` },
            forged: { token: net.signService({ cap: CAPS, key: otherKey }) },
            'wrong audience': { token: net.signService({ cap: CAPS, aud: ['openvibe.live'] }) },
            'expired service': { token: net.signService({ cap: CAPS, expSec: -60 }) },
            sandbox: { token: net.signService({ sub: 'app:app_01HZX3K5V7Q9M2N4P6R8T0W2Y4', actorType: 'app', cap: CAPS, extra: { env: 'sandbox' } }) },
            'bad subject': { token: svcToken, headers: { 'x-ov-subject': 'alex' } },
            'staff without the grant': { token: net.signService({ cap: ['community.paste.create'] }), headers: { 'x-ov-staff': '1' } },
        };
        const writes = [
            ['POST', '/api/pastes'], ['PUT', `/api/pastes/${pub.slug}`], ['DELETE', `/api/pastes/${pub.slug}`], ['POST', '/api/pastes/bulk'],
            ['POST', `/api/pastes/${pub.slug}/comments`], ['POST', '/api/v1/spaces/general/threads'], ['PUT', `/api/v1/posts/${thread.post.id}`],
            ['POST', '/api/v1/comments/threads/resolve'], ['PATCH', `/api/v1/comments/${comment.comment.id}`], ['PUT', '/api/v1/spaces/general/members-only'],
            ['POST', '/api/v1/relay/mappings'], ['POST', '/api/v1/pulse/items'], ['PUT', '/api/v1/space-groups/x'], ['POST', '/auth/fedcm'], ['POST', '/release-metrics'],
        ];
        for (const [method, path] of writes) {
            for (const [who, p] of Object.entries({ ...personas, ...bad })) {
                inspect(`${method} ${path} malformed as ${who}`, await send(method, path, { ...p, headers: { ...(p.headers || {}), 'content-type': 'application/json' }, body: '{"bad json' }));
                inspect(`${method} ${path} {} as ${who}`, await send(method, path, { ...p, json: {} }));
            }
        }
        for (const [who, p] of Object.entries(bad)) {
            for (const path of ['/api/pastes', `/api/pastes/${priv.slug}`, '/api/v1/spaces', '/api/v1/relay/status', '/api/v1/pulse', '/auth/me', '/my', '/s', '/']) inspect(`GET ${path} as ${who}`, await send('GET', path, p));
        }
        for (const path of ['/nope', '/api/nope', '/api/v1/nope', '/internal/nope', '/api/pastes/admin/nope', '/p/..%2f..%2fetc', '/s/general/t/nope/nope', '/c/nope', '/api/v1/comments/threads/1', '/api/v1/comments/1']) {
            for (const [who, p] of Object.entries(personas)) inspect(`GET ${path} as ${who}`, await send('GET', path, p));
        }
        // Sign-in failures: a bad code, a missing state, a refused refresh token, a refused FedCM assertion.
        inspect('callback, bad code', await send('GET', '/auth/callback?code=bad-code&state=abc', { cookie: 'ov_oauth_state=abc' }));
        inspect('callback, no state', await send('GET', '/auth/callback?code=good-code'));
        inspect('callback, provider error', await send('GET', '/auth/callback?error=access_denied&error_description=nope'));
        inspect('login', await send('GET', '/auth/login?next=/my'));
        inspect('logout', await send('GET', '/auth/logout', { cookie: 'ov_refresh=refresh-1' }));
        inspect('refresh refused', await send('POST', '/auth/refresh', { cookie: 'ov_refresh=wrong' }));
        inspect('fedcm refused', await send('POST', '/auth/fedcm', { json: { token: 'x.y.z', nonce: 'n' } }));
        // Refused writes, in full.
        inspect('anonymous thread', await send('POST', '/api/v1/spaces/general/threads', { json: { title: 't', body: 'b' } }));
        inspect('user edits the relay', await send('POST', '/api/v1/relay/mappings', { ...personas.user, json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL' } }));
        inspect('mapping to another variable', await send('POST', '/api/v1/relay/mappings', { ...personas.admin, json: { space: 'general', webhook_url_ref: 'OV_OAUTH_CLIENT_SECRET' } }));
        inspect('not an image', await send('POST', '/api/pastes/screenshot', { ...personas.user, body: (() => { const f = new FormData(); f.append('screenshot', new Blob(['text'], { type: 'text/plain' }), 'a.txt'); return f; })() }));
        // Events deliveries: unsigned, signed with another secret, and from behind a proxy.
        const body = JSON.stringify({ event: { event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN09', event_type: 'network.block.changed' }, seq: 2 });
        inspect('event unsigned', await send('POST', '/internal/events', { direct: true, headers: { 'content-type': 'application/json' }, body }));
        inspect('event forged', await send('POST', '/internal/events', { direct: true, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, `whsec_${'cd'.repeat(32)}`) }, body }));
        inspect('event proxied', await send('POST', '/internal/events', { headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, EVENTS_SECRETS[0]) }, body }));
        if (problems.length) console.log(`    ${problems.slice(0, 60).join('\n    ')}`);
        assert.deepStrictEqual(problems, []);
    });

    await check('health, readiness, metrics, release and the staff relay and paste admin reads', async () => {
        const probes = [['/api/health'], ['/api/ready'], ['/release.json'], ['/metrics', true], ['/api/v1/relay/status'], ['/api/v1/relay/mappings'], ['/api/v1/relay/deliveries'],
            ['/api/v1/relay/deliveries?status=failed'], ['/api/v1/relay/inbound'], ['/api/pastes/config'], ['/api/pastes/admin/stats'], ['/api/pastes/admin/forks']];
        for (const [path, direct] of probes) {
            for (const who of ['admin', 'service']) {
                const r = await send('GET', path, { ...personas[who], direct: !!direct });
                assert.ok(r.status < 500 || path === '/api/ready', `${path} as ${who}: ${r.status}`);
                inspect(`GET ${path} as ${who}`, r);
            }
        }
        const metrics = await send('GET', '/metrics', { direct: true });
        assert.strictEqual(metrics.status, 200, 'the loopback caller reads /metrics (so it was really checked)');
        const ready = JSON.parse((await send('GET', '/api/ready', { direct: true })).text);
        assert.ok(ready.discord_relay && ready.discord_relay.inbound, 'readiness reports the relay and its gateway (where a webhook or token could show)');
        const deliveries = JSON.parse((await send('GET', '/api/v1/relay/deliveries?status=failed', personas.admin)).text);
        assert.ok(JSON.stringify(deliveries).includes('Unknown Webhook'), 'the failed delivery and its error are listed');
        if (problems.length) console.log(`    ${problems.slice(0, 60).join('\n    ')}`);
        assert.deepStrictEqual(problems, []);
    });

    await check('the events outbox, the relay\'s recorded errors and the service\'s own tables hold no secret', async () => {
        const outbox = await t.db.prepare('SELECT envelope FROM event_outbox').all();
        assert.ok(outbox.length >= 5, `events were queued (${outbox.length})`);
        const where = [];
        for (const row of outbox) { const f = leaksIn(typeof row.envelope === 'string' ? row.envelope : JSON.stringify(row.envelope)); if (f.length) where.push(`outbox: ${f.join(', ')}`); }
        for (const table of ['relay_deliveries', 'relay_mappings', 'relay_inbound_failures', 'pastes', 'paste_comments', 'posts', 'threads', 'comments', 'comment_threads', 'pulse_items', 'search_doc_pushes']) {
            for (const row of await t.db.prepare(`SELECT * FROM ${table}`).all()) { const f = leaksIn(JSON.stringify(row)); if (f.length) where.push(`${table}: ${f.join(', ')}`); }
        }
        assert.deepStrictEqual(where, []);
    });

    await check(`nothing the process logged while serving (${requests} requests) carries a secret`, async () => {
        assert.ok(logged.length > 0, 'the log capture works');
        assert.deepStrictEqual(leaksIn(logged), []);
    });

    await t.close();
    done();
})();
