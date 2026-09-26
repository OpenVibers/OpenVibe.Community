'use strict';
/**
 * Private things stay private on every read path (roadmap WS-R task 5: private bypass). Extends
 * members-only.test.js (VIP gating rules) and security.test.js (burn-after-read, unlisted slugs) with a
 * crawl and the paths those do not cover.
 *
 * Seeded, each with a marker in its title/body: alex's private text and screenshot pastes (and a comment
 * on one), an unlisted paste, burn-after-read pastes, a members-only (VIP) space and a members-only thread
 * in a public space (VIP is down: fail closed), a staff space, a members (signed-in) space, a hidden
 * comment thread, and the comment thread of a (possibly private) Live VOD that only Live can open.
 *
 *   - Every GET route Express knows after boot (router stack) is requested with those ids and with the
 *     ids of things that do not exist, plus a query string (lists, search, ?fork=, include_unlisted), as
 *     anonymous, another user, and a service acting for that user: no marker ever appears (a gated
 *     thread's title is the documented exception: it is listed, never its posts), and every route
 *     answers a private paste, a staff space, a hidden comment thread or a staff post exactly as it
 *     answers an unknown one (same status and error code or page title).
 *   - Explicitly: each read and read-like write of a private paste answers like a missing one (and the
 *     owner still gets it); unlisted pastes open by link but are never listed; a burn-after-read
 *     screenshot's link is the read; hidden threads and a VOD thread's sequential id look missing to
 *     browsers; nothing private is a Pulse item, a search document, or a public event (comment events
 *     are public only for items Community knows are public).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { listRoutes, fill } = require('./helpers/routes');

const M = {
    PRIVTITLE: 'PRIVTITLE-kestrel', PRIVBODY: 'PRIVBODY-kestrel', PRIVSHOT: 'PRIVSHOT-heron', PRIVCOMMENT: 'PRIVCOMMENT-wren',
    UNLTITLE: 'UNLTITLE-osprey', UNLBODY: 'UNLBODY-osprey', BURNTITLE: 'BURNTITLE-falcon', BURNBODY: 'BURNBODY-falcon',
    GATEDBODY: 'GATEDBODY-otter', GATEDREPLY: 'GATEDREPLY-otter', GATEDSPACETITLE: 'GATEDSPACETITLE-lynx', GATEDSPACEBODY: 'GATEDSPACEBODY-lynx',
    STAFFSPACE: 'STAFFSPACE-ibis', STAFFTITLE: 'STAFFTITLE-ibis', STAFFBODY: 'STAFFBODY-ibis',
    MEMBERSPACE: 'MEMBERSPACE-puffin', MEMBERTITLE: 'MEMBERTITLE-puffin', MEMBERBODY: 'MEMBERBODY-puffin',
    HIDDENCOMMENT: 'HIDDENCOMMENT-crane', VODCOMMENT: 'VODCOMMENT-swift',
};
const GATEDTITLE = 'GATEDTITLE-otter';   // listed by title, by design
const UNKNOWN_SLUG = 'calm-otter-AAAAAAAAAAAAAAAA';
const UNKNOWN_ACCESS = `cth_${'A'.repeat(22)}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

(async () => {
    const t = await boot({
        authority: 'community',
        // VIP, Search and Events are down (nothing listens on port 9): gates fail closed.
        env: { OV_VIP_INTERNAL_URL: 'http://127.0.0.1:9', OV_SEARCH_INTERNAL_URL: 'http://127.0.0.1:9' },
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            startRelay: false,
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, votes: { perMinute: 1000 }, threadsPerDay: 1000 },
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
        },
    });
    const events = require('../server/events');
    events.init(t.db, { eventsUrl: 'http://127.0.0.1:9', clientSecret: 'shh', intervalMs: 3_600_000, fetchImpl: async () => { throw new Error('offline'); } });
    const net = t.network;
    const mk = (id, username, role = 'user') => {
        const u = net.addUser({ network_user_id: id, username, display_name: username });
        return { ...u, jwt: net.sign({ id, subject_id: u.subject_id, username, display_name: username, role }) };
    };
    const alex = mk(31, 'alex'), sam = mk(32, 'sam'), cora = mk(33, 'cora'), boss = mk(34, 'boss', 'global_mod');
    const svcFor = (who, cap = ['community.paste.write', 'community.comment.write', 'community.post.create']) => ({ token: net.signService({ sub: 'svc:tools', cap }), headers: { 'x-ov-subject': who.subject_id } });
    const liveSvc = { token: net.signService({ sub: 'svc:live', cap: ['community.comment.write', 'community.comment.moderate'] }) };

    let ipN = 0;
    async function send(method, path, { who, token, headers = {}, json, body } = {}) {
        const h = { 'x-forwarded-for': `198.51.100.${(ipN++ % 250) + 1}`, ...headers };
        if (who) h.cookie = `ov_token=${who.jwt}`;
        if (token) h.authorization = `Bearer ${token}`;
        let payload = body;
        if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
        const res = await fetch(t.base + path, { method, headers: h, body: payload, redirect: 'manual' });
        return { status: res.status, headers: res.headers, text: await res.text(), json() { return JSON.parse(this.text); } };
    }
    const ok = (r, what) => { assert.ok(r.status === 200 || r.status === 201, `${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.json(); };
    const paste = async (who, fields) => ok(await send('POST', '/api/pastes', { who, json: fields }), `paste ${fields.title}`);
    const shotPaste = async (who, fields) => {
        const f = new FormData();
        for (const [k, v] of Object.entries(fields)) f.append(k, String(v));
        f.append('screenshot', new Blob([PNG], { type: 'image/png' }), 'shot.png');
        return ok(await send('POST', '/api/pastes/screenshot', { who, body: f }), `screenshot ${fields.title}`);
    };

    // ── seed ──
    const pub = await paste(alex, { title: 'Public paste', content: 'public words zebra' });
    const priv = await paste(alex, { title: M.PRIVTITLE, content: `${M.PRIVBODY} zebra`, visibility: 'private' });
    const privShot = await shotPaste(alex, { title: M.PRIVSHOT, description: M.PRIVSHOT, visibility: 'private' });
    const unl = await paste(alex, { title: M.UNLTITLE, content: `${M.UNLBODY} zebra`, visibility: 'unlisted' });
    const burn = await paste(alex, { title: M.BURNTITLE, content: `${M.BURNBODY} zebra`, burn_after_read: true });
    const burnShot = await shotPaste(alex, { title: 'burning screenshot', burn_after_read: 'true' });
    const privComment = ok(await send('POST', `/api/pastes/${priv.slug}/comments`, { who: alex, json: { message: M.PRIVCOMMENT } }), 'private paste comment');

    ok(await send('PUT', '/api/v1/spaces/showcase/members-only', { who: boss, json: { owner: cora.subject_id } }), 'gate showcase');
    const gatedSpaceThread = ok(await send('POST', '/api/v1/spaces/showcase/threads', { who: cora, json: { title: M.GATEDSPACETITLE, body: M.GATEDSPACEBODY } }), 'thread in the gated space');
    const gated = ok(await send('POST', '/api/v1/spaces/general/threads', { who: cora, json: { title: GATEDTITLE, body: `${M.GATEDBODY} zebra`, members_only: true } }), 'gated thread');
    const gatedReply = ok(await send('POST', `/api/v1/spaces/general/threads/${gated.thread.slug}/posts`, { who: cora, json: { body: M.GATEDREPLY } }), 'gated reply');
    ok(await send('POST', '/api/v1/spaces', { who: boss, json: { slug: 'mods-room', name: M.STAFFSPACE, description: M.STAFFSPACE, visibility: 'staff' } }), 'staff space');
    const staff = ok(await send('POST', '/api/v1/spaces/mods-room/threads', { who: boss, json: { title: M.STAFFTITLE, body: M.STAFFBODY } }), 'staff thread');
    ok(await send('POST', '/api/v1/spaces', { who: boss, json: { slug: 'members-lounge', name: M.MEMBERSPACE, description: M.MEMBERSPACE, visibility: 'members' } }), 'members space');
    const member = ok(await send('POST', '/api/v1/spaces/members-lounge/threads', { who: alex, json: { title: M.MEMBERTITLE, body: M.MEMBERBODY } }), 'members thread');
    const publicThread = ok(await send('POST', '/api/v1/spaces/general/threads', { who: alex, json: { title: 'Open thread', body: 'open words zebra' } }), 'public thread');

    const hidden = ok(await send('POST', '/api/v1/comments/threads/resolve', { ...liveSvc, json: { ref: { service: 'live', type: 'vod', id: '501' } } }), 'hidden thread').thread;
    const hiddenComment = ok(await send('POST', `/api/v1/comments/threads/${hidden.id}/comments`, { ...liveSvc, headers: { 'x-ov-subject': alex.subject_id }, json: { message: M.HIDDENCOMMENT } }), 'hidden comment').comment;
    ok(await send('PUT', `/api/v1/comments/threads/${hidden.access_id}/visibility`, { who: boss, json: { visibility: 'hidden' } }), 'hide the thread');
    const vod = ok(await send('POST', '/api/v1/comments/threads/resolve', { ...liveSvc, json: { ref: { service: 'live', type: 'vod', id: '502' } } }), 'vod thread').thread;
    const vodComment = ok(await send('POST', `/api/v1/comments/threads/${vod.id}/comments`, { ...liveSvc, headers: { 'x-ov-subject': alex.subject_id }, json: { message: M.VODCOMMENT } }), 'vod comment').comment;
    const unlThread = ok(await send('POST', '/api/v1/comments/threads/resolve', { who: alex, json: { ref: { service: 'community', type: 'paste', id: unl.slug } } }), 'unlisted paste thread').thread;
    ok(await send('POST', `/api/v1/comments/threads/${unlThread.id}/comments`, { who: alex, json: { message: 'on the unlisted paste' } }), 'unlisted paste comment');
    const pubThread = ok(await send('POST', '/api/v1/comments/threads/resolve', { who: alex, json: { ref: { service: 'community', type: 'paste', id: pub.slug } } }), 'public paste thread').thread;
    ok(await send('POST', `/api/v1/comments/threads/${pubThread.id}/comments`, { who: alex, json: { message: 'on the public paste' } }), 'public paste comment');
    require('../server/search/documents').createSearchDocuments({ db: t.db }).scan();

    const outsiders = { anonymous: {}, sam: { who: sam }, 'a service for sam': svcFor(sam) };
    const allMarkers = Object.values(M);
    // Signed-in people are members of a members space (every account, for now); first-party services read threads by their sequential id.
    const forbiddenFor = {
        anonymous: allMarkers,
        sam: allMarkers.filter((m) => !m.startsWith('MEMBER')),
        'a service for sam': allMarkers.filter((m) => !m.startsWith('MEMBER') && m !== M.VODCOMMENT),
    };

    await check('private pastes: every read path answers an outsider exactly as it answers a paste that does not exist; the owner still reads them', async () => {
        const reads = (slug) => [`/api/pastes/${slug}`, `/api/pastes/${slug}?no_view=1`, `/p/${slug}`, `/p/${slug}/raw`, `/p/${slug}/download`, `/p/${slug}/screenshot`,
            `/api/pastes/${slug}/comments`, `/api/pastes/${slug}/versions`, `/api/pastes/${slug}/raw`, `/pastes/${slug}`];
        for (const [name, p] of Object.entries(outsiders)) {
            for (const slug of [priv.slug, privShot.slug]) {
                const paths = reads(slug), unknown = reads(UNKNOWN_SLUG);
                for (let i = 0; i < paths.length; i++) {
                    const a = await send('GET', paths[i], p), b = await send('GET', unknown[i], p);
                    assert.strictEqual(a.status, b.status, `${paths[i]} as ${name}: ${a.status} vs ${b.status} for a missing paste`);
                    for (const m of allMarkers) assert.ok(!a.text.includes(m), `${paths[i]} as ${name} shows ${m}`);
                }
            }
            // Read-like writes: like, copy, fork, comment, delete a comment — 404 like a missing paste, nothing written.
            const before = JSON.stringify(t.db.prepare('SELECT id, likes, copies, revision FROM pastes ORDER BY id').all()) + t.db.prepare('SELECT COUNT(*) AS n FROM paste_comments').get().n;
            for (const [method, suffix, json] of [['POST', '/like'], ['POST', '/copy'], ['POST', '/fork', {}], ['POST', '/comments', { message: 'hi there' }], ['DELETE', `/comments/${privComment.comment.id}`]]) {
                const a = await send(method, `/api/pastes/${priv.slug}${suffix}`, { ...p, json }), b = await send(method, `/api/pastes/${UNKNOWN_SLUG}${suffix}`, { ...p, json });
                assert.strictEqual(a.status, b.status, `${method} ${suffix} as ${name}: ${a.status} vs ${b.status}`);
                assert.ok(!allMarkers.some((m) => a.text.includes(m)), `${method} ${suffix} as ${name} shows a marker`);
            }
            const after = JSON.stringify(t.db.prepare('SELECT id, likes, copies, revision FROM pastes ORDER BY id').all()) + t.db.prepare('SELECT COUNT(*) AS n FROM paste_comments').get().n;
            assert.strictEqual(after, before, `a refused write changed something (${name})`);
            // A browser cannot open a comment thread on it either (it looks missing).
            if (p.who) {
                const r = await send('POST', '/api/v1/comments/threads/resolve', { ...p, json: { ref: { service: 'community', type: 'paste', id: priv.slug } } });
                const u = await send('POST', '/api/v1/comments/threads/resolve', { ...p, json: { ref: { service: 'community', type: 'paste', id: UNKNOWN_SLUG } } });
                assert.deepStrictEqual([r.status, r.json().code], [u.status, u.json().code]);
            }
        }
        // Positive controls: the owner reads everything.
        assert.strictEqual((await send('GET', `/api/pastes/${priv.slug}`, { who: alex })).json().paste.content, `${M.PRIVBODY} zebra`);
        assert.strictEqual((await send('GET', `/p/${priv.slug}/raw`, { who: alex })).text, `${M.PRIVBODY} zebra`);
        assert.ok((await send('GET', `/p/${priv.slug}`, { who: alex })).text.includes(M.PRIVTITLE));
        assert.strictEqual((await send('GET', `/p/${privShot.slug}/screenshot`, { who: alex })).status, 302);
        assert.ok((await send('GET', `/api/pastes/${priv.slug}/comments`, { who: alex })).text.includes(M.PRIVCOMMENT));
        assert.strictEqual((await send('GET', `/api/pastes/${priv.slug}`, svcFor(alex))).status, 200, 'a service acting for the owner');
    });

    await check('unlisted pastes open by their link but are never listed: lists, user lists, counts, search (also include_unlisted from someone else)', async () => {
        for (const [name, p] of Object.entries(outsiders)) {
            assert.strictEqual((await send('GET', `/api/pastes/${unl.slug}`, p)).status, 200, `the link works (${name})`);
            for (const path of ['/api/pastes?limit=200', '/api/pastes?search=zebra', '/api/pastes?username=alex&include_unlisted=1', '/api/pastes/by-user/alex?limit=100', '/pastes?q=zebra', '/']) {
                const r = await send('GET', path, p);
                for (const m of [M.UNLTITLE, M.UNLBODY, M.PRIVTITLE, M.BURNTITLE, M.BURNBODY]) assert.ok(!r.text.includes(m), `${path} as ${name} shows ${m}`);
                for (const s of [unl.slug, priv.slug, privShot.slug, burn.slug, burnShot.slug]) assert.ok(!r.text.includes(s), `${path} as ${name} lists a hidden slug`);
            }
            const mine = (await send('GET', '/api/pastes/by-user/alex?limit=100', p)).json();
            assert.strictEqual(mine.total, mine.pastes.length, `the count is of what is listed (${name})`);
        }
        const own = (await send('GET', '/api/pastes/by-user/alex?limit=100', { who: alex })).json().pastes.map((x) => x.slug);
        for (const s of [unl.slug, priv.slug]) assert.ok(own.includes(s), 'the owner sees their own');
    });

    await check('burn-after-read screenshots: the screenshot link is the read (a second read of any kind finds it burned)', async () => {
        const first = await send('GET', `/p/${burnShot.slug}/screenshot`, { who: sam });
        assert.strictEqual(first.status, 302, first.text);
        const again = await send('GET', `/p/${burnShot.slug}/screenshot`, { who: sam });
        assert.ok(again.status === 404 || again.status === 410, `the screenshot was served again: ${again.status}`);
        assert.ok([404, 410].includes((await send('GET', `/api/pastes/${burnShot.slug}`)).status), 'the paste burned');
        // The owner's own looks do not burn it.
        const mineToo = await shotPaste(alex, { title: 'mine', burn_after_read: 'true' });
        for (let i = 0; i < 3; i++) assert.strictEqual((await send('GET', `/p/${mineToo.slug}/screenshot`, { who: alex })).status, 302);
        assert.strictEqual((await send('GET', `/api/pastes/${mineToo.slug}`, { who: sam })).status, 200, 'still unread');
    });

    await check('comment threads: hidden ones and a VOD thread\'s sequential id look missing to browsers; moderators and Live still reach them', async () => {
        for (const [name, p] of Object.entries(outsiders)) {
            const pairs = [[`/api/v1/comments/threads/${hidden.access_id}`, `/api/v1/comments/threads/${UNKNOWN_ACCESS}`], [`/c/${hidden.access_id}`, `/c/${UNKNOWN_ACCESS}`],
                [`/api/v1/comments/${hiddenComment.id}`, '/api/v1/comments/999999'], [`/api/v1/comments/threads/${hidden.access_id}/comments`, `/api/v1/comments/threads/${UNKNOWN_ACCESS}/comments`, 'POST'],
                [`/api/v1/comments/${hiddenComment.id}/votes`, '/api/v1/comments/999999/votes', 'POST']];
            if (p.who || name === 'anonymous') pairs.push([`/api/v1/comments/threads/${vod.id}`, '/api/v1/comments/threads/999999'], [`/api/v1/comments/${vodComment.id}`, '/api/v1/comments/999998']);
            for (const [a, b, method = 'GET'] of pairs) {
                const json = method === 'POST' ? { message: 'x', value: 1 } : undefined;
                const ra = await send(method, a, { ...p, json }), rb = await send(method, b, { ...p, json });
                assert.strictEqual(ra.status, rb.status, `${method} ${a} as ${name}: ${ra.status} vs ${rb.status}`);
                assert.ok(!ra.text.includes(M.HIDDENCOMMENT) && !(p.who && ra.text.includes(M.VODCOMMENT)), `${a} as ${name} shows a comment`);
            }
            // Browsers cannot open a VOD's thread themselves (only Live knows who may see the VOD).
            if (p.who) assert.strictEqual((await send('POST', '/api/v1/comments/threads/resolve', { ...p, json: { ref: { service: 'live', type: 'vod', id: '502' } } })).status, 403);
        }
        assert.ok((await send('GET', `/api/v1/comments/threads/${hidden.access_id}`, { who: boss })).text.includes(M.HIDDENCOMMENT), 'moderators read hidden threads');
        assert.ok((await send('GET', `/api/v1/comments/threads/${vod.id}`, liveSvc)).text.includes(M.VODCOMMENT), 'Live reads by the sequential id');
        assert.ok((await send('GET', `/api/v1/comments/threads/${vod.access_id}`, { who: sam })).text.includes(M.VODCOMMENT), 'whoever Live gave the access id reads it');
    });

    await check('events, Pulse and search documents: nothing private is public; comment events are public only for items Community knows are public', async () => {
        const outbox = t.db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map((r) => JSON.parse(r.envelope));
        const text = JSON.stringify(outbox);
        for (const m of [...allMarkers, GATEDTITLE]) assert.ok(!text.includes(m), `an event carries ${m}`);
        const pub = (e) => e.visibility === 'public';
        const pasteEvent = (slug) => outbox.find((e) => e.event_type === 'community.paste.created' && e.payload.paste_id === slug);
        for (const s of [priv.slug, privShot.slug, unl.slug]) {
            assert.ok(!pub(pasteEvent(s)), `the paste ${s} is a public event`);
            assert.strictEqual(pasteEvent(s).payload.url, null);
        }
        for (const id of [gated.thread.id, gatedSpaceThread.thread.id, staff.thread.id, member.thread.id]) {
            const e = outbox.find((x) => x.event_type === 'community.thread.created' && x.payload.thread_id === id);
            assert.ok(e && !pub(e) && e.payload.url === null, `thread ${id} is a public event`);
        }
        assert.ok(!pub(outbox.find((x) => x.event_type === 'community.post.created' && x.payload.post_id === gatedReply.post.id)));
        const commentEvent = (accessId) => outbox.filter((e) => e.event_type === 'community.comment.created' && e.payload.thread_access_id === accessId);
        for (const [what, th] of [['a Live VOD (maybe private)', vod], ['a hidden thread', hidden], ['an unlisted paste', unlThread]]) {
            const evs = commentEvent(th.access_id);
            assert.ok(evs.length, `no event for the comment on ${what}`);
            for (const e of evs) {
                assert.strictEqual(e.visibility, 'internal', `the comment on ${what} is a public event: its thread's access id and ref (${JSON.stringify(e.payload.ref)}) reach every realtime listener`);
                assert.strictEqual(e.payload.url, null);
            }
        }
        const open = commentEvent(pubThread.id);
        assert.ok(open.length && open.every(pub) && open[0].payload.url.endsWith(`/c/${pubThread.id}`), 'a comment on a public paste stays a public event');
        const docs = JSON.stringify(outbox.filter((e) => /^community\.index_document\./.test(e.event_type)));
        assert.ok(docs.includes(pub.slug) || docs.includes('Open thread'), 'search documents were built');
        for (const s of [priv.slug, privShot.slug, unl.slug, burn.slug, burnShot.slug, gated.thread.slug, gatedSpaceThread.thread.slug, staff.thread.slug, member.thread.slug]) assert.ok(!docs.includes(s), `${s} is a search document`);
        const pulse = JSON.stringify(t.db.prepare('SELECT * FROM pulse_items').all());
        assert.ok(pulse.includes('Open thread'), 'Pulse took the public thread');
        for (const m of [...allMarkers, GATEDTITLE]) assert.ok(!pulse.includes(m), `Pulse holds ${m}`);
    });

    // ── the crawl ──
    const routes = listRoutes(t.app).filter((r) => r.method === 'GET' || r.method === 'ALL');
    const values = {
        slug: [priv.slug, privShot.slug, gated.thread.slug, gatedSpaceThread.thread.slug, staff.thread.slug, member.thread.slug, publicThread.thread.slug, UNKNOWN_SLUG],
        space: ['general', 'showcase', 'mods-room', 'members-lounge', 'no-such-space'],
        username: ['alex', 'cora', 'boss'],
        id: [String(gatedReply.post.id), String(staff.post.id), String(member.post.id), String(gatedSpaceThread.post.id), hidden.access_id, String(hidden.id), String(vod.id), '999999'],
        accessId: [hidden.access_id, UNKNOWN_ACCESS],
        commentId: [String(privComment.comment.id), String(hiddenComment.id), String(vodComment.id), '999999'],
        category: ['no-such-category'], group: ['no-such-group'], service: ['community'], type: ['paste'], '*': ['x'],
    };
    const QUERY = `?limit=200&sort=new&q=zebra&search=zebra&type=paste&username=alex&include_unlisted=1&fork=${priv.slug}&page=1`;

    await check(`every GET route (${routes.length}, from the router stack) with the private ids, as anonymous, another user and a service for them: no private title or body anywhere`, async () => {
        assert.ok(routes.length >= 50, 'the router walk is broken');
        const problems = [];
        let n = 0;
        for (const r of routes) {
            for (const path of fill(r.path, values, 80)) {
                for (const [name, p] of Object.entries(outsiders)) {
                    for (const q of ['', QUERY]) {
                        const res = await send('GET', path + q, p);
                        n++;
                        const found = forbiddenFor[name].filter((m) => res.text.includes(m) || String(res.headers.get('location') || '').includes(m));
                        if (found.length) problems.push(`GET ${path}${q ? '?…' : ''} as ${name} (${res.status}): ${found.join(', ')}`);
                    }
                }
            }
        }
        assert.ok(n > 1000, `only ${n} requests`);
        if (problems.length) console.log(`    ${problems.slice(0, 60).join('\n    ')}`);
        assert.deepStrictEqual(problems, []);
    });

    await check('every GET route answers a private paste, a staff space, a staff post and a hidden comment thread exactly as an unknown one', async () => {
        const sig = (res) => {
            let code = '';
            try { const j = JSON.parse(res.text); code = j.code || j.error || ''; } catch { const m = /<title>([^<]*)<\/title>/.exec(res.text); code = m ? m[1] : ''; }
            return `${res.status} ${code}`.trim();
        };
        // [param values for the private thing, the same for a missing one]
        const families = [
            { when: (p) => /^\/(api\/pastes|p|pastes)\/:slug/.test(p), hidden: [{ slug: priv.slug }, { slug: privShot.slug }], missing: { slug: UNKNOWN_SLUG } },
            { when: (p) => p.includes(':space'), hidden: [{ space: 'mods-room', slug: staff.thread.slug }], missing: { space: 'no-such-space', slug: staff.thread.slug } },
            { when: (p) => p.includes(':space') && p.includes(':slug'), hidden: [{ space: 'general', slug: staff.thread.slug }], missing: { space: 'general', slug: 'no-such-thread' } },
            { when: (p) => /^\/api\/v1\/posts\/:id/.test(p), hidden: [{ id: String(staff.post.id) }], missing: { id: '999999' } },
            { when: (p) => p.includes(':accessId') || /\/comments\/threads\/:id/.test(p), hidden: [{ accessId: hidden.access_id, id: hidden.access_id }], missing: { accessId: UNKNOWN_ACCESS, id: UNKNOWN_ACCESS } },
            { when: (p) => /^\/api\/v1\/comments\/:commentId/.test(p), hidden: [{ commentId: String(hiddenComment.id) }], missing: { commentId: '999999' } },
        ];
        const problems = [];
        let compared = 0;
        for (const r of routes) {
            for (const fam of families) {
                if (!fam.when(r.path)) continue;
                for (const h of fam.hidden) {
                    const a = fill(r.path, { ...values, ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k, [v]])), commentId: ['999999'] }, 1)[0];
                    const b = fill(r.path, { ...values, ...Object.fromEntries(Object.entries(fam.missing).map(([k, v]) => [k, [v]])), commentId: ['999999'] }, 1)[0];
                    for (const [name, p] of Object.entries(outsiders)) {
                        const ra = await send('GET', a, p), rb = await send('GET', b, p);
                        compared++;
                        if (sig(ra) !== sig(rb)) problems.push(`GET ${a} as ${name}: ${sig(ra)} vs ${sig(rb)} for ${b}`);
                    }
                }
            }
        }
        assert.ok(compared > 50, `only ${compared} comparisons`);
        if (problems.length) console.log(`    ${problems.slice(0, 60).join('\n    ')}`);
        assert.deepStrictEqual(problems, []);
    });

    await t.close();
    done();
})();
