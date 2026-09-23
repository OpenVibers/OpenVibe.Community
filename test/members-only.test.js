'use strict';
/**
 * Members-only discussion (OpenVibe.VIP): a forum space or a single thread gated to one creator's
 * VIP members. Reading and posting need VIP's yes (POST /api/v1/policies/evaluate with the owner
 * Community stored, through the product cache); the owner and moderators pass; signed-out, strangers,
 * VIP down and no client secret are refused (fail closed); nothing gated reaches Pulse, the sitemap,
 * feeds, JSON-LD or the SSR page of someone without access. Convergence: once VIP stops granting,
 * Community stops within the cache TTL (30 s), and at once on vip.membership.changed.
 */
const http = require('http');
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

/** A stand-in for VIP's evaluate: answers from `allow` (member subject → true), records calls. */
function startVip() {
    const state = { allow: new Set(), down: false, calls: [] };
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            if (state.down) { req.socket.destroy(); return; }
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
            state.calls.push({ path: req.url, auth: req.headers.authorization || '', body });
            if (req.method !== 'POST' || req.url !== '/api/v1/policies/evaluate') { res.writeHead(404); return res.end('{}'); }
            const yes = state.allow.has(`${body.subject}|${body.owner}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(yes
                ? { allow: true, reason: 'member', rule: null, fallback: true, entitlement: { status: 'active', active: true, expires_at: '2100-01-01T00:00:00.000Z', valid_until: '2100-01-01T00:00:00.000Z' } }
                : { allow: false, reason: 'not_a_member', rule: null, fallback: true, entitlement: { status: 'inactive', active: false } }));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ ...state, state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const vip = await startVip();
    process.env.OV_VIP_INTERNAL_URL = vip.url;
    process.env.OV_VIP_URL = 'https://openvibe.vip';
    const clock = { t: Date.now() };
    const t = await boot({
        authority: 'community',
        appOpts: {
            vipOptions: { now: () => clock.t },
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, votes: { perMinute: 1000 }, threadsPerDay: 1000 },
        },
    });
    const net = t.network;
    const mk = (id, username, role = 'user') => {
        const u = net.addUser({ network_user_id: id, username, display_name: username });
        return { ...u, jwt: net.sign({ id, subject_id: u.subject_id, username, display_name: username, role }) };
    };
    const cora = mk(21, 'cora');           // the creator
    const mia = mk(22, 'mia');             // her member
    const stan = mk(23, 'stan');           // not a member
    const newbie = mk(24, 'newbie');       // a member VIP cannot confirm while down
    const conv = mk(25, 'conv');           // convergence
    const boss = mk(26, 'boss', 'global_mod');
    vip.state.allow.add(`${mia.subject_id}|${cora.subject_id}`);
    vip.state.allow.add(`${newbie.subject_id}|${cora.subject_id}`);

    const call = (path, { method = 'GET', who, json, headers = {} } = {}) => {
        const h = { ...headers };
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: who ? [`ov_token=${who.jwt}`] : [] });
    };
    const form = (path, who, fields) => t.get(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), cookies: who ? [`ov_token=${who.jwt}`] : [] });
    const evaluateCalls = () => vip.state.calls.filter((c) => c.path === '/api/v1/policies/evaluate').length;
    let secret;          // a gated thread in a public space
    let showcaseThread;  // a thread in the gated space

    await check('marking: moderators gate a space for a creator; others cannot; the owner must be a usr_ subject', async () => {
        assert.strictEqual((await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: cora, json: { owner: cora.subject_id } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: boss, json: { owner: 'cora' } })).status, 400);
        const r = await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: boss, json: { owner: cora.subject_id } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json().space.members_only, { owner: cora.subject_id, owner_username: 'cora', join_url: 'https://openvibe.vip/cora' });
        const list = (await call('/api/v1/spaces', { who: stan })).json().spaces;
        assert.strictEqual(list.find((s) => s.slug === 'showcase').members_only.join_url, 'https://openvibe.vip/cora', 'the space is listed with its join link');
        assert.strictEqual(list.find((s) => s.slug === 'general').members_only, null);
    });

    await check('a gated space: the member, the owner and moderators read and post; VIP is asked with the owner and the default gate', async () => {
        const before = vip.state.calls.length;
        const r = await call('/api/v1/spaces/showcase/threads', { method: 'POST', who: mia, json: { title: 'Members lounge', body: 'members-only body text' } });
        assert.strictEqual(r.status, 201, r.text);
        showcaseThread = r.json().thread;
        const asked = vip.state.calls.slice(before).find((c) => c.path === '/api/v1/policies/evaluate');
        assert.deepStrictEqual(asked.body.resource, { service: 'community', type: 'space', id: 'showcase' });
        assert.strictEqual(asked.body.owner, cora.subject_id);
        assert.strictEqual(asked.body.subject, mia.subject_id);
        assert.deepStrictEqual(asked.body.fallback, { requirement: 'member', binding: 'community:members_only' });
        assert.ok(/^Bearer /.test(asked.auth), 'a service token for openvibe.vip');
        assert.ok(net.grants.some((g) => g.audience === 'openvibe.vip' && g.scope === 'vip.resource.policy.evaluate'));
        assert.strictEqual((await call('/api/v1/spaces/showcase/threads', { who: mia })).status, 200);
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}`, { who: mia })).json().posts[0].body_markdown, 'members-only body text');
        const n = evaluateCalls();
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}`, { who: cora })).status, 200, 'the owner');
        assert.strictEqual(evaluateCalls(), n, 'the owner passes without asking VIP');
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}/posts`, { method: 'POST', who: boss, json: { body: 'mod note' } })).status, 201, 'moderators');
    });

    await check('a gated space refuses strangers and signed-out visitors with 403 vip.members_only and the join link', async () => {
        for (const [who, reason] of [[stan, 'not_a_member'], [null, 'not_signed_in']]) {
            const r = await call('/api/v1/spaces/showcase/threads', { who });
            assert.strictEqual(r.status, 403, r.text);
            const p = r.json();
            assert.strictEqual(p.code, 'vip.members_only');
            assert.strictEqual(p.reason, reason);
            assert.strictEqual(p.members_only.join_url, 'https://openvibe.vip/cora');
            assert.ok(!r.text.includes('members-only body text'));
            assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}`, { who })).status, 403);
        }
        assert.strictEqual((await call('/api/v1/spaces/showcase/threads', { method: 'POST', who: stan, json: { title: 'Let me in', body: 'x' } })).status, 403);
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}/posts`, { method: 'POST', who: stan, json: { body: 'x' } })).status, 403);
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${showcaseThread.slug}/votes`, { method: 'POST', who: stan, json: { value: 1 } })).status, 403);
    });

    await check('VIP down: a member VIP cannot confirm is refused (fail closed)', async () => {
        vip.state.down = true;
        try {
            const r = await call('/api/v1/spaces/showcase/threads', { who: newbie });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(r.json().reason, 'vip_unavailable');
        } finally { vip.state.down = false; }
        clock.t += 2_001;   // failures are cached 2 s
        assert.strictEqual((await call('/api/v1/spaces/showcase/threads', { who: newbie })).status, 200);
    });

    await check('no client secret: nobody but the owner gets in, and VIP is never called', async () => {
        const { createVipGate } = require('../server/vip');
        const config = require('../server/config');
        const gate = createVipGate({ config: { ...config, oauth: { clientId: 'community', clientSecret: '' } } });
        const n = vip.state.calls.length;
        const d = await gate.check({ subject: mia.subject_id, type: 'space', id: 'showcase', owner: cora.subject_id });
        assert.deepStrictEqual([d.allow, d.reason], [false, 'vip_unavailable']);
        assert.strictEqual((await gate.check({ subject: cora.subject_id, type: 'space', id: 'showcase', owner: cora.subject_id })).allow, true);
        assert.strictEqual(vip.state.calls.length, n);
    });

    await check('a gated thread in a public space: the author gates it to their members; listed by title only', async () => {
        const r = await call('/api/v1/spaces/general/threads', { method: 'POST', who: cora, json: { title: 'Backstage with Cora', body: 'secret backstage body', members_only: true } });
        assert.strictEqual(r.status, 201, r.text);
        secret = r.json().thread;
        assert.strictEqual(secret.members_only.owner, cora.subject_id);
        const listed = (await call('/api/v1/spaces/general/threads?sort=new', { who: stan })).json();
        const row = listed.threads.find((x) => x.id === secret.id);
        assert.strictEqual(row.title, 'Backstage with Cora');
        assert.strictEqual(row.members_only.join_url, 'https://openvibe.vip/cora');
        assert.ok(!JSON.stringify(listed).includes('secret backstage body'));
        const refused = await call(`/api/v1/spaces/general/threads/${secret.slug}`, { who: stan });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.json().gate, 'thread');
        assert.ok(!refused.text.includes('secret backstage body'));
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${secret.slug}`, { who: mia })).json().posts[0].body_markdown, 'secret backstage body');
        const reply = await call(`/api/v1/spaces/general/threads/${secret.slug}/posts`, { method: 'POST', who: mia, json: { body: 'member reply' } });
        assert.strictEqual(reply.status, 201);
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${secret.slug}/posts`, { method: 'POST', who: stan, json: { body: 'x' } })).status, 403);
        // Edits need access too: stan cannot edit (not his), and an author who lost access cannot either.
        assert.strictEqual((await call(`/api/v1/posts/${reply.json().post.id}`, { method: 'PUT', who: stan, json: { body: 'y' } })).status, 403);
    });

    await check('thread gating permissions: only the author (own members) or moderators; others cannot claim someone else\'s members', async () => {
        const open = (await call('/api/v1/spaces/general/threads', { method: 'POST', who: stan, json: { title: 'Stan open thread', body: 'open body' } })).json().thread;
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: mia, json: { owner: mia.subject_id } })).status, 403, 'not the author');
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: stan, json: { owner: cora.subject_id } })).status, 403, 'the author gates to their own members only');
        const own = await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: stan, json: { owner: true } });
        assert.strictEqual(own.status, 200, own.text);
        assert.strictEqual(own.json().thread.members_only.owner, stan.subject_id);
        const cleared = await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: stan, json: { owner: null } });
        assert.strictEqual(cleared.json().thread.members_only, null);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { method: 'POST', who: stan, json: { title: 'Claim', body: 'x', members_only: { owner: cora.subject_id } } })).status, 403);
        const mod = await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: boss, json: { owner: cora.subject_id } });
        assert.strictEqual(mod.json().thread.members_only.owner, cora.subject_id, 'moderators name any creator');
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: stan, json: { owner: null } })).status, 403, 'the author cannot open what a moderator gated to another creator');
        await call(`/api/v1/spaces/general/threads/${open.slug}/members-only`, { method: 'PUT', who: boss, json: { owner: null } });
    });

    await check('nothing gated leaks: Pulse, sitemap, feeds, space feed, JSON-LD', async () => {
        const pulse = (await call('/api/v1/pulse')).text;
        assert.ok(!pulse.includes('Backstage with Cora') && !pulse.includes('Members lounge') && !pulse.includes('member reply'));
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS c FROM pulse_items WHERE source_type = 'thread' AND source_id IN (?, ?)").get(String(secret.id), String(showcaseThread.id)).c, 0);
        const sitemap = (await call('/sitemap.xml')).text;
        assert.ok(!sitemap.includes(secret.slug) && !sitemap.includes('/s/showcase'), 'no gated thread or space in the sitemap');
        const feed = (await call('/s/feed.xml')).text;
        assert.ok(!feed.includes('Backstage') && !feed.includes('Members lounge'));
        assert.strictEqual((await call('/s/showcase/feed.xml')).status, 404);
        const general = (await call('/s/general/feed.xml')).text;
        assert.ok(!general.includes('Backstage') && !general.includes('secret backstage body'));
        // A thread gated after the fact leaves Pulse as well.
        const later = (await call('/api/v1/spaces/general/threads', { method: 'POST', who: cora, json: { title: 'Soon private', body: 'soon' } })).json().thread;
        assert.ok((await call('/api/v1/pulse')).text.includes('Soon private'));
        await call(`/api/v1/spaces/general/threads/${later.slug}/members-only`, { method: 'PUT', who: cora, json: { owner: true } });
        assert.ok(!(await call('/api/v1/pulse')).text.includes('Soon private'));
        // Pulse's read-time check alone hides an item nothing removed.
        t.db.prepare("INSERT INTO pulse_items (source_service, source_type, source_id, title, url, origin, visibility, occurred_at) VALUES ('community', 'thread', ?, 'stale gated item', 'https://openvibe.community/x', 'user', 'public', datetime('now'))").run(String(secret.id));
        assert.ok(!(await call('/api/v1/pulse')).text.includes('stale gated item'));
    });

    await check('SSR: a teaser with the join link (403, noindex) for outsiders; the posts for members, still noindex and without JSON-LD', async () => {
        const anon = await call(`/s/general/t/${secret.slug}`);
        assert.strictEqual(anon.status, 403);
        assert.ok(anon.text.includes('https://openvibe.vip/cora'));
        assert.ok(anon.text.includes('Backstage with Cora'));
        assert.ok(!anon.text.includes('secret backstage body') && !anon.text.includes('member reply'));
        assert.ok(/noindex/.test(anon.text));
        assert.ok(anon.text.includes('/auth/login?next='), 'signed out: a sign-in link');
        const space = await call('/s/showcase', { who: stan });
        assert.strictEqual(space.status, 403);
        assert.ok(space.text.includes('https://openvibe.vip/cora') && !space.text.includes('Members lounge'));
        assert.strictEqual((await call('/s/showcase/new', { who: stan })).status, 403, 'no new-thread form for outsiders');
        const reply = await form(`/s/general/t/${secret.slug}/reply`, stan, { body: 'sneaky' });
        assert.strictEqual(reply.status, 403);
        const member = await call(`/s/general/t/${secret.slug}`, { who: mia });
        assert.strictEqual(member.status, 200);
        assert.ok(member.text.includes('secret backstage body'));
        assert.ok(/noindex/.test(member.text));
        assert.ok(!member.text.includes('DiscussionForumPosting'), 'no structured data for a gated thread');
        const listing = await call('/s/general', { who: stan });
        assert.ok(listing.text.includes('Backstage with Cora') && listing.text.includes('VIP members only'));
        assert.ok(!listing.text.includes('secret backstage body'));
        // The author's no-JS toggle.
        const own = (await call('/api/v1/spaces/general/threads', { method: 'POST', who: cora, json: { title: 'Toggle me', body: 'toggle' } })).json().thread;
        const page = await call(`/s/general/t/${own.slug}`, { who: cora });
        assert.ok(page.text.includes(`/s/general/t/${own.slug}/members-only`));
        const on = await form(`/s/general/t/${own.slug}/members-only`, cora, { on: '1' });
        assert.strictEqual(on.status, 303);
        assert.strictEqual((await call(`/s/general/t/${own.slug}`, { who: stan })).status, 403);
    });

    await check('convergence: VIP stops granting → Community refuses within the cache TTL (30 s); at once on vip.membership.changed', async () => {
        vip.state.allow.add(`${conv.subject_id}|${cora.subject_id}`);
        const path = `/api/v1/spaces/general/threads/${secret.slug}`;
        assert.strictEqual((await call(path, { who: conv })).status, 200);
        vip.state.allow.delete(`${conv.subject_id}|${cora.subject_id}`);       // VIP applied the change
        clock.t += 29_999;
        assert.strictEqual((await call(path, { who: conv })).status, 200, 'inside the bound the cached yes may still answer');
        clock.t += 2;
        assert.strictEqual((await call(path, { who: conv })).status, 403, 'past 30 s VIP is asked again and says no');
        // With the event: at once.
        vip.state.allow.add(`${conv.subject_id}|${cora.subject_id}`);
        clock.t += 10_001;                                                      // the cached "no" expires
        assert.strictEqual((await call(path, { who: conv })).status, 200);
        vip.state.allow.delete(`${conv.subject_id}|${cora.subject_id}`);
        const understood = t.app.locals.vip.cache.handleEvent({ event_type: 'vip.membership.changed', payload: { member: { type: 'user', id: conv.subject_id }, creator: { type: 'user', id: cora.subject_id }, active: false } });
        assert.strictEqual(understood, true);
        assert.strictEqual((await call(path, { who: conv })).status, 403, 'no clock movement needed');
        assert.strictEqual(t.app.locals.vip.bounds.grantMs, 30_000);
    });

    await check('a moderator opens a space again; guest subjects and ids are never owners', async () => {
        assert.strictEqual((await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: boss, json: { owner: ids.newId('guest') } })).status, 400);
        const r = await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: boss, json: { owner: null } });
        assert.strictEqual(r.json().space.members_only, null);
        assert.strictEqual((await call('/api/v1/spaces/showcase/threads', { who: stan })).status, 200);
        assert.ok((await call('/sitemap.xml')).text.includes('/s/showcase'));
    });

    await t.close();
    await vip.close();
    done();
})();
