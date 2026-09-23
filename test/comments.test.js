'use strict';
/**
 * /api/v1/comments — typed comment threads: resolve (idempotent, allowlist, services, labels,
 * Community refs), pagination and one-level nesting, anonymous comments under the shared
 * anonymous-write budget, per-person limits, votes, deletes, visibility (lock/hide), service
 * capabilities (including the local match for ids openvibe-contracts does not know yet), CORS.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { checkCapability } = require('../server/identity/capabilities');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'admin' });
    const svc = (cap, extra = {}) => net.signService({ cap, ...extra });
    const WRITE = 'community.comment.write', MOD = 'community.comment.moderate';

    const call = (path, { method = 'GET', token, cookie, headers = {}, json, ip } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (ip) h['x-forwarded-for'] = ip;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const resolve = (ref, who = {}) => call('/api/v1/comments/threads/resolve', { method: 'POST', json: { ref }, ...who });
    const post = (id, json, who = {}) => call(`/api/v1/comments/threads/${id}/comments`, { method: 'POST', json, ...who });

    let vod;

    await check('capabilities: proposed ids match locally (exact or prefix.*); known ids go through the library', () => {
        assert.strictEqual(checkCapability({ cap: [WRITE] }, WRITE).allowed, true);
        assert.strictEqual(checkCapability({ cap: ['community.comment.*'] }, MOD).allowed, true);
        assert.strictEqual(checkCapability({ cap: ['community.*'] }, 'community.pulse.write').allowed, true);
        assert.deepStrictEqual(checkCapability({ cap: ['community.paste.write'] }, WRITE), { allowed: false, code: 'capability.denied', reason: `${WRITE} not granted` });
        assert.strictEqual(checkCapability({ cap: ['community.comment.writer'] }, WRITE).allowed, false, 'no partial-word matches');
        assert.strictEqual(checkCapability({ cap: ['x.y'] }, 'community.nothing.here').code, 'capability.unknown', 'ids nobody proposed stay unknown');
        assert.strictEqual(checkCapability({ cap: ['community.paste.create'] }, 'community.paste.create').allowed, true);
    });

    await check('resolve: get-or-create, idempotent (201 then 200, same id), unique per service+type+id', async () => {
        const ref = { service: 'live', type: 'vod', id: '123' };
        const a = await resolve(ref, { cookie: alexJwt });
        assert.strictEqual(a.status, 201, a.text);
        assert.strictEqual(a.json().created, true);
        vod = a.json().thread;
        assert.deepStrictEqual(vod.ref, ref);
        assert.strictEqual(vod.visibility, 'public');
        assert.strictEqual(vod.comment_count, 0);
        const b = await resolve(ref);
        assert.strictEqual(b.status, 200);
        assert.strictEqual(b.json().thread.id, vod.id);
        assert.strictEqual(b.json().created, false);
        const other = await resolve({ service: 'live', type: 'clip', id: '123' });
        assert.notStrictEqual(other.json().thread.id, vod.id);
        assert.strictEqual(t.db.prepare("SELECT COUNT(*) AS c FROM comment_threads WHERE ref_service = 'live' AND ref_type = 'vod' AND ref_id = '123'").get().c, 1);
    });

    await check('resolve: browsers only for allowlisted types; services with comment.write for any; labels only from services', async () => {
        const denied = await resolve({ service: 'games', type: 'map', id: '1' }, { cookie: alexJwt });
        assert.strictEqual(denied.status, 403);
        assert.strictEqual(denied.json().code, 'ref.type_not_allowed');
        assert.match(denied.headers.get('content-type'), /application\/problem\+json/);
        const wrongType = await resolve({ service: 'live', type: 'user', id: '1' });
        assert.strictEqual(wrongType.status, 403);
        const invalid = await resolve({ service: 'live', type: 'vod' });
        assert.strictEqual(invalid.status, 400);
        assert.strictEqual(invalid.json().code, 'ref.invalid');
        const extra = await resolve({ service: 'live', type: 'vod', id: '1', evil: true });
        assert.strictEqual(extra.status, 400, 'EntityRef allows no extra fields');
        const game = await resolve({ service: 'games', type: 'map', id: '1', label: 'Map One' }, { token: svc([WRITE]) });
        assert.strictEqual(game.status, 201, game.text);
        assert.strictEqual(game.json().thread.ref.label, 'Map One');
        const noCap = await resolve({ service: 'games', type: 'map', id: '2' }, { token: svc(['community.paste.write']) });
        assert.strictEqual(noCap.status, 403);
        assert.strictEqual(noCap.json().code, 'capability.denied');
        const prefix = await resolve({ service: 'games', type: 'map', id: '3' }, { token: svc(['community.*']) });
        assert.strictEqual(prefix.status, 201, 'a community.* grant covers the proposed ids');
        const browserLabel = await resolve({ service: 'wiki', type: 'page', id: 'Home', label: 'I say so' }, { cookie: alexJwt });
        assert.strictEqual(browserLabel.json().thread.ref.label, undefined);
    });

    await check('resolve: Community refs must exist — pastes (not private) and posts in public spaces', async () => {
        const pub = (await t.app.locals.pastes.createText({ kind: 'user', subject: alex.subject_id, origin: 'user' }, { content: 'hello', visibility: 'public' })).slug;
        const priv = (await t.app.locals.pastes.createText({ kind: 'user', subject: alex.subject_id, origin: 'user' }, { content: 'secret', visibility: 'private' })).slug;
        assert.strictEqual((await resolve({ service: 'community', type: 'paste', id: pub })).status, 201);
        assert.strictEqual((await resolve({ service: 'community', type: 'paste', id: priv })).status, 404);
        assert.strictEqual((await resolve({ service: 'community', type: 'paste', id: 'no-such-paste-1' })).status, 404);
        const { post: op } = await t.app.locals.forum.createThread({ kind: 'user', subject: alex.subject_id, origin: 'user' }, 'general', { title: 'A thread', body: 'first' });
        assert.strictEqual((await resolve({ service: 'community', type: 'post', id: String(op.id) })).status, 201);
        assert.strictEqual((await resolve({ service: 'community', type: 'post', id: '999999' })).status, 404);
    });

    await check('comment: signed-in author from the JWT (body identity ignored), projection names, count kept', async () => {
        const r = await post(vod.id, { message: '  first!  ', author_subject: sam.subject_id, user_id: 9 }, { cookie: alexJwt });
        assert.strictEqual(r.status, 201, r.text);
        const c = r.json().comment;
        assert.strictEqual(c.message, 'first!');
        assert.strictEqual(c.author.subject, alex.subject_id);
        assert.strictEqual(c.author.username, 'alex');
        assert.strictEqual(c.display_name, 'Alex');
        assert.strictEqual(c.anon_name, null);
        assert.strictEqual(c.origin, 'user');
        assert.strictEqual(c.can_delete, true);
        assert.strictEqual(t.db.prepare('SELECT comment_count FROM comment_threads WHERE id = ?').get(vod.id).comment_count, 1);
        assert.strictEqual((await post(vod.id, { message: '   ' }, { cookie: alexJwt })).status, 400);
        assert.strictEqual((await post(vod.id, { message: 'x'.repeat(5001) }, { cookie: alexJwt })).status, 400);
        assert.strictEqual((await post(99999, { message: 'hi' }, { cookie: alexJwt })).status, 404);
    });

    await check('anonymous comments: sanitized anon_name; the shared 20-per-10-minutes budget per address', async () => {
        const ip = '203.0.113.77';
        const r = await post(vod.id, { message: 'drive-by', anon_name: '<b>Ghost</b>!' }, { ip });
        assert.strictEqual(r.status, 201, r.text);
        const c = r.json().comment;
        assert.strictEqual(c.author, null);
        assert.strictEqual(c.anon_name, 'bGhostb');
        assert.strictEqual(c.can_delete, false);
        // The paste API and the comment API draw from the same anonymous budget.
        for (let i = 0; i < 18; i++) assert.strictEqual((await call('/api/pastes', { method: 'POST', json: { content: `anon ${i}` }, ip })).status, 201);
        assert.strictEqual((await post(vod.id, { message: 'one more' }, { ip })).status, 201);
        const over = await post(vod.id, { message: 'too many' }, { ip });
        assert.strictEqual(over.status, 429);
        assert.strictEqual((await post(vod.id, { message: 'signed in is fine' }, { cookie: samJwt, ip })).status, 201);
    });

    await check('per-person limits: cooldown, duplicate text, per-minute cap — the same person via a service too', async () => {
        const { createCommentService } = require('../server/comments/service');
        const strict = createCommentService({ db: t.db, limits: { comments: { cooldownSec: 10, perMinute: 5 } } });
        const who = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
        await strict.add(who, vod.id, { message: 'one' });
        await assert.rejects(strict.add(who, vod.id, { message: 'two' }), (e) => e.status === 429 && /wait/.test(e.message));
        const loose = createCommentService({ db: t.db, limits: { comments: { cooldownSec: 0, perMinute: 3 } } });
        await loose.add(who, vod.id, { message: 'a' });
        await assert.rejects(loose.add(who, vod.id, { message: 'a' }), (e) => e.status === 400 && e.code === 'request.duplicate');
        await loose.add(who, vod.id, { message: 'b' });
        await loose.add(who, vod.id, { message: 'c' });
        await assert.rejects(loose.add({ kind: 'service', subject: who.subject, origin: 'user', claims: { cap: [WRITE] } }, vod.id, { message: 'd' }), (e) => e.status === 429);
    });

    await check('replies nest one level: a reply to a reply joins the top-level comment; foreign parents refused', async () => {
        const top = (await post(vod.id, { message: 'top level' }, { cookie: alexJwt })).json().comment;
        const r1 = (await post(vod.id, { message: 'reply', parent_id: top.id }, { cookie: samJwt })).json().comment;
        const r2 = await post(vod.id, { message: 'reply to reply', parent_id: r1.id }, { cookie: alexJwt });
        assert.strictEqual(r2.json().comment.parent_id, top.id);
        const other = (await resolve({ service: 'live', type: 'vod', id: '456' })).json().thread;
        assert.strictEqual((await post(other.id, { message: 'cross', parent_id: top.id }, { cookie: alexJwt })).status, 400);
        const page = (await call(`/api/v1/comments/threads/${vod.id}?limit=100`)).json();
        const shown = page.comments.find((c) => c.id === top.id);
        assert.strictEqual(shown.reply_count, 2);
        assert.deepStrictEqual(shown.replies.map((r) => r.message), ['reply', 'reply to reply']);
        assert.ok(page.comments.every((c) => c.parent_id === null), 'only top-level comments at the top');
        const replies = (await call(`/api/v1/comments/threads/${vod.id}?parent=${top.id}&after=${r1.id}`)).json();
        assert.deepStrictEqual(replies.comments.map((c) => c.message), ['reply to reply']);
    });

    await check('pagination: ?after= cursor, oldest first by default, ?sort=new newest first, next_cursor ends', async () => {
        const th = (await resolve({ service: 'blog', type: 'post', id: 'pagination' })).json().thread;
        for (let i = 1; i <= 7; i++) await post(th.id, { message: `m${i}` }, { token: svc([WRITE]), headers: { 'x-ov-subject': sam.subject_id } });
        const seen = [];
        let cursor = '';
        for (let guard = 0; guard < 10; guard++) {
            const r = (await call(`/api/v1/comments/threads/${th.id}?limit=3${cursor ? `&after=${cursor}` : ''}`)).json();
            seen.push(...r.comments.map((c) => c.message));
            if (!r.next_cursor) break;
            cursor = r.next_cursor;
        }
        assert.deepStrictEqual(seen, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
        const newest = (await call(`/api/v1/comments/threads/${th.id}?limit=2&sort=new`)).json();
        assert.deepStrictEqual(newest.comments.map((c) => c.message), ['m7', 'm6']);
        const next = (await call(`/api/v1/comments/threads/${th.id}?limit=2&sort=new&after=${newest.next_cursor}`)).json();
        assert.deepStrictEqual(next.comments.map((c) => c.message), ['m5', 'm4']);
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}?after=abc`)).status, 400);
    });

    await check('votes: add, change, remove; score recomputed; my_vote; people only', async () => {
        const c = (await post(vod.id, { message: 'vote on me' }, { cookie: alexJwt })).json().comment;
        const vote = (value, who) => call(`/api/v1/comments/${c.id}/votes`, { method: 'POST', json: { value }, ...who });
        assert.deepStrictEqual((await vote(1, { cookie: samJwt })).json(), { comment_id: c.id, score: 1, upvotes: 1, downvotes: 0, my_vote: 1 });
        assert.strictEqual((await vote(1, { cookie: alexJwt })).json().score, 2);
        assert.deepStrictEqual((await vote(-1, { cookie: samJwt })).json(), { comment_id: c.id, score: 0, upvotes: 1, downvotes: 1, my_vote: -1 });
        assert.strictEqual((await vote(0, { cookie: samJwt })).json().score, 1);
        assert.strictEqual((await vote(0, { cookie: samJwt })).json().score, 1, 'removing twice is harmless');
        assert.strictEqual((await vote(2, { cookie: samJwt })).status, 400);
        assert.strictEqual((await vote(1, {})).status, 401, 'anonymous cannot vote');
        assert.strictEqual((await vote(1, { token: svc([WRITE]) })).status, 401, 'a service must name the person');
        assert.strictEqual((await vote(-1, { token: svc([WRITE]), headers: { 'x-ov-subject': sam.subject_id } })).json().score, 0);
        const page = (await call(`/api/v1/comments/threads/${vod.id}?limit=100`, { cookie: alexJwt })).json();
        assert.strictEqual(page.comments.find((x) => x.id === c.id).my_vote, 1);
        assert.strictEqual(t.db.prepare('SELECT COUNT(*) AS n FROM comment_votes WHERE comment_id = ?').get(c.id).n, 2);
    });

    await check('delete: author or staff; others 403; tombstone keeps replies; counts follow', async () => {
        const top = (await post(vod.id, { message: 'to be deleted' }, { cookie: alexJwt })).json().comment;
        await post(vod.id, { message: 'a reply that stays', parent_id: top.id }, { cookie: samJwt });
        const before = t.db.prepare('SELECT comment_count FROM comment_threads WHERE id = ?').get(vod.id).comment_count;
        assert.strictEqual((await call(`/api/v1/comments/${top.id}`, { method: 'DELETE', cookie: samJwt })).status, 403);
        assert.strictEqual((await call(`/api/v1/comments/${top.id}`, { method: 'DELETE' })).status, 401);
        assert.strictEqual((await call(`/api/v1/comments/${top.id}`, { method: 'DELETE', token: svc([WRITE]), headers: { 'x-ov-subject': sam.subject_id } })).status, 403);
        const ok = await call(`/api/v1/comments/${top.id}`, { method: 'DELETE', cookie: alexJwt });
        assert.strictEqual(ok.status, 200, ok.text);
        assert.strictEqual(t.db.prepare('SELECT comment_count FROM comment_threads WHERE id = ?').get(vod.id).comment_count, before - 1);
        assert.strictEqual(t.db.prepare('SELECT message FROM comments WHERE id = ?').get(top.id).message, '', 'scrubbed');
        const page = (await call(`/api/v1/comments/threads/${vod.id}?limit=100`)).json();
        const tomb = page.comments.find((c) => c.id === top.id);
        assert.ok(tomb && tomb.deleted && tomb.message === null && tomb.author === null);
        assert.deepStrictEqual(tomb.replies.map((r) => r.message), ['a reply that stays']);
        assert.strictEqual((await call(`/api/v1/comments/${top.id}`, { method: 'DELETE', cookie: alexJwt })).status, 404);
        const staffTarget = (await post(vod.id, { message: 'staff removes this' }, { cookie: samJwt })).json().comment;
        assert.strictEqual((await call(`/api/v1/comments/${staffTarget.id}`, { method: 'DELETE', cookie: adminJwt })).status, 200);
        const viaService = (await post(vod.id, { message: 'service staff removes this' }, { cookie: samJwt })).json().comment;
        const noVouch = await call(`/api/v1/comments/${viaService.id}`, { method: 'DELETE', token: svc([WRITE, MOD]), headers: { 'x-ov-subject': alex.subject_id } });
        assert.strictEqual(noVouch.status, 403, 'acting for a non-staff person');
        const vouch = await call(`/api/v1/comments/${viaService.id}`, { method: 'DELETE', token: svc([WRITE, MOD]), headers: { 'x-ov-subject': alex.subject_id, 'x-ov-staff': '1' } });
        assert.strictEqual(vouch.status, 200, vouch.text);
    });

    await check('visibility: services need comment.moderate; locked = read-only; hidden = 404 except moderators', async () => {
        const th = (await resolve({ service: 'live', type: 'clip', id: 'vis-1' })).json().thread;
        const c = (await post(th.id, { message: 'before lock' }, { cookie: samJwt })).json().comment;
        const put = (visibility, who) => call(`/api/v1/comments/threads/${th.id}/visibility`, { method: 'PUT', json: { visibility }, ...who });
        assert.strictEqual((await put('locked', { token: svc([WRITE]) })).status, 403);
        assert.strictEqual((await put('locked', { cookie: alexJwt })).status, 403, 'people are not moderators');
        assert.strictEqual((await put('bogus', { token: svc([MOD]) })).status, 400);
        const locked = await put('locked', { token: svc([MOD]) });
        assert.strictEqual(locked.status, 200, locked.text);
        assert.strictEqual(locked.json().thread.visibility, 'locked');
        const blocked = await post(th.id, { message: 'after lock' }, { cookie: samJwt });
        assert.strictEqual(blocked.status, 403);
        assert.strictEqual(blocked.json().code, 'thread.locked');
        assert.strictEqual((await call(`/api/v1/comments/${c.id}/votes`, { method: 'POST', json: { value: 1 }, cookie: alexJwt })).status, 403);
        const read = (await call(`/api/v1/comments/threads/${th.id}`)).json();
        assert.strictEqual(read.comments.length, 1);
        assert.strictEqual(read.viewer.can_comment, false);
        assert.strictEqual((await post(th.id, { message: 'staff may' }, { cookie: adminJwt })).status, 201);

        assert.strictEqual((await put('hidden', { cookie: adminJwt })).status, 200, 'staff browsers too');
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}`)).status, 404);
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await post(th.id, { message: 'hidden?' }, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/api/v1/comments/${c.id}`, { method: 'DELETE', cookie: samJwt })).status, 404);
        const again = (await resolve({ service: 'live', type: 'clip', id: 'vis-1' })).json().thread;
        assert.deepStrictEqual(again, { id: th.id, ref: { service: 'live', type: 'clip', id: 'vis-1' }, visibility: 'hidden', comment_count: null });
        const mod = await call(`/api/v1/comments/threads/${th.id}`, { token: svc([MOD]) });
        assert.strictEqual(mod.status, 200);
        assert.strictEqual(mod.json().comments.length, 2);
        assert.strictEqual((await put('public', { token: svc([MOD]) })).json().thread.visibility, 'public');
        assert.strictEqual((await post(th.id, { message: 'open again' }, { cookie: samJwt })).status, 201);
    });

    await check('AI comments from a service: origin ai, never attributed, labelled', async () => {
        const r = await post(vod.id, { message: 'summary of the stream', anon_name: 'Pretender' }, { token: svc([WRITE]), headers: { 'x-ov-origin': 'ai', 'x-ov-subject': alex.subject_id } });
        assert.strictEqual(r.status, 201, r.text);
        const c = r.json().comment;
        assert.strictEqual(c.origin, 'ai');
        assert.strictEqual(c.author.subject, null);
        assert.strictEqual(c.author.is_ai, true);
        assert.strictEqual(c.display_name, 'OpenVibe AI');
        assert.strictEqual(c.anon_name, null);
        assert.strictEqual(t.db.prepare('SELECT author_subject FROM comments WHERE id = ?').get(c.id).author_subject, null);
        assert.strictEqual((await call(`/api/v1/comments/threads/${vod.id}`, { token: svc(['community.pulse.write']) })).status, 403, 'reads need a comment capability');
    });

    await check('CORS: OpenVibe origins get Bearer-only CORS headers; others none; preflight answers 204', async () => {
        const pre = await call(`/api/v1/comments/threads/${vod.id}/comments`, { method: 'OPTIONS', headers: { origin: 'https://openvibe.live', 'access-control-request-method': 'POST' } });
        assert.strictEqual(pre.status, 204);
        assert.strictEqual(pre.headers.get('access-control-allow-origin'), 'https://openvibe.live');
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
        assert.strictEqual(pre.headers.get('access-control-allow-credentials'), null);
        const evil = await call(`/api/v1/comments/threads/${vod.id}`, { headers: { origin: 'https://evil.example' } });
        assert.strictEqual(evil.headers.get('access-control-allow-origin'), null);
        const bearer = await call(`/api/v1/comments/threads/${vod.id}/comments`, { method: 'POST', token: alexJwt, headers: { origin: 'https://openvibe.live' }, json: { message: 'from live, by bearer' } });
        assert.strictEqual(bearer.status, 201, bearer.text);
        assert.strictEqual(bearer.json().comment.author.subject, alex.subject_id);
    });

    await t.close();
    done();
})();
