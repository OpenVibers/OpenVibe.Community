'use strict';
/**
 * Pulse: Community's own public activity enters at write time (public pastes by people, threads
 * and replies in public spaces) and leaves when it stops being public; other services publish
 * with community.pulse.write (own refs only, public only, provenance kept); the list is cursor
 * paginated and filterable by origin; AI items are labelled and never name a person; /pulse
 * renders without JavaScript.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { forumLimits: { threads: { cooldownSec: 0 }, posts: { cooldownSec: 0 } } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    const anon = { kind: 'anonymous', subject: null, staff: false, origin: 'user' };
    const pastes = t.app.locals.pastes;
    const forum = t.app.locals.forum;
    const svc = (cap, extra = {}) => net.signService({ cap, ...extra });
    const PULSE = 'community.pulse.write';
    const items = () => t.db.prepare('SELECT * FROM pulse_items ORDER BY id').all();
    const bySource = (type, id) => t.db.prepare("SELECT * FROM pulse_items WHERE source_service = 'community' AND source_type = ? AND source_id = ?").get(type, String(id));
    const call = (path, { method = 'GET', token, headers = {}, json } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (json !== undefined) h['content-type'] = 'application/json';
        return t.get(path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
    };

    await check('pastes: only public, person-written, not burn-after-read, not NSFW pastes enter', async () => {
        const pub = (await pastes.createText(asAlex, { title: 'Public one', content: 'x' })).slug;
        const anonPub = (await pastes.createText(anon, { title: 'Anonymous public', content: 'y' })).slug;
        const unl = (await pastes.createText(asAlex, { content: 'z', visibility: 'unlisted' })).slug;
        const priv = (await pastes.createText(asAlex, { content: 'p', visibility: 'private' })).slug;
        const burn = (await pastes.createText(asAlex, { content: 'b', burn_after_read: true })).slug;
        const nsfw = (await pastes.createText(asAlex, { content: 'n', is_nsfw: true })).slug;
        const ai = (await pastes.createText({ kind: 'service', subject: null, origin: 'ai', claims: { cap: [] } }, { content: 'a' })).slug;
        const it = bySource('paste', pub);
        assert.ok(it, 'public paste recorded');
        assert.deepStrictEqual([it.title, it.url, it.actor_subject, it.origin, it.visibility], ['Public one', `https://openvibe.community/p/${pub}`, alex.subject_id, 'user', 'public']);
        assert.strictEqual(bySource('paste', anonPub).actor_subject, null);
        for (const s of [unl, priv, burn, nsfw, ai]) assert.strictEqual(bySource('paste', s), undefined, `${s} must not enter Pulse`);
    });

    await check('pastes leave Pulse when made private or deleted; read-time guard covers what the hooks miss', async () => {
        const a = (await pastes.createText(asAlex, { title: 'Soon private', content: '1' })).slug;
        const b = (await pastes.createText(asAlex, { title: 'Soon deleted', content: '2' })).slug;
        const c = (await pastes.createText(asAlex, { title: 'Changed behind our back', content: '3' })).slug;
        await pastes.update(asAlex, a, { visibility: 'private' });
        pastes.remove(asAlex, b);
        assert.strictEqual(bySource('paste', a), undefined);
        assert.strictEqual(bySource('paste', b), undefined);
        t.db.prepare("UPDATE pastes SET visibility = 'unlisted' WHERE slug = ?").run(c); // no hook ran
        assert.ok(bySource('paste', c), 'row still there');
        const listed = (await call('/api/v1/pulse?limit=100')).json().items.map((i) => i.source.id);
        assert.ok(!listed.includes(c), 'but never listed');
    });

    await check('threads and replies in public spaces enter; members spaces never; deletes remove', async () => {
        const { thread } = await forum.createThread(asAlex, 'general', { title: 'Pulse thread', body: 'hello' });
        const it = bySource('thread', thread.id);
        assert.deepStrictEqual([it.title, it.url, it.actor_subject, it.origin], ['Pulse thread', 'https://openvibe.community/s/general/t/pulse-thread', alex.subject_id, 'user']);
        const { post } = await forum.reply(asAlex, 'general', 'pulse-thread', { body: 'a reply' });
        assert.strictEqual(bySource('post', post.id).title, 'Re: Pulse thread');
        assert.strictEqual(bySource('post', post.id).url, `https://openvibe.community/s/general/t/pulse-thread#post-${post.id}`);
        t.db.prepare("INSERT INTO spaces (slug, name, visibility) VALUES ('insiders', 'Insiders', 'members')").run();
        const hidden = await forum.createThread(asAlex, 'insiders', { title: 'Members only', body: 'x' });
        assert.strictEqual(bySource('thread', hidden.thread.id), undefined);
        forum.deletePost(asAlex, post.id);
        assert.strictEqual(bySource('post', post.id), undefined);
        forum.deleteThread(asAlex, 'general', 'pulse-thread');
        assert.strictEqual(bySource('thread', thread.id), undefined);
    });

    await check('POST /items: services with community.pulse.write only; browsers and other caps refused', async () => {
        const body = { ref: { service: 'live', type: 'clip', id: 'c1' }, title: 'Great clip', url: 'https://openvibe.live/clip/c1' };
        assert.strictEqual((await t.get('/api/v1/pulse/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cookies: [`ov_token=${alexJwt}`] })).status, 403);
        assert.strictEqual((await call('/api/v1/pulse/items', { method: 'POST', json: body })).status, 403);
        const noCap = await call('/api/v1/pulse/items', { method: 'POST', token: svc(['community.comment.write']), json: body });
        assert.strictEqual(noCap.status, 403);
        assert.strictEqual(noCap.json().code, 'capability.denied');
        const ok = await call('/api/v1/pulse/items', { method: 'POST', token: svc([PULSE]), headers: { 'x-ov-subject': alex.subject_id }, json: body });
        assert.strictEqual(ok.status, 201, ok.text);
        const it = ok.json().item;
        assert.deepStrictEqual(it.source, { service: 'live', type: 'clip', id: 'c1' });
        assert.strictEqual(it.origin, 'user');
        assert.strictEqual(it.actor.username, 'alex');
        assert.strictEqual(it.label, null);
    });

    await check('POST /items: own refs only, public only, valid title/url/time; idempotent, provenance kept', async () => {
        const post = (json, headers = {}, cap = [PULSE]) => call('/api/v1/pulse/items', { method: 'POST', token: svc(cap), headers, json });
        const base = { ref: { service: 'live', type: 'vod', id: 'v9' }, title: 'A VOD', url: 'https://openvibe.live/vod/v9' };
        assert.strictEqual((await post({ ...base, ref: { service: 'media', type: 'object', id: 'x' } })).json().code, 'pulse.foreign_ref');
        assert.strictEqual((await post({ ...base, ref: { service: 'community', type: 'paste', id: 'x' } })).status, 403, 'nobody writes Community items from outside');
        for (const visibility of ['unlisted', 'private', 'members']) assert.strictEqual((await post({ ...base, visibility })).json().code, 'pulse.not_public');
        assert.strictEqual((await post({ ...base, url: 'javascript:alert(1)' })).json().code, 'pulse.invalid_url');
        assert.strictEqual((await post({ ...base, title: '' })).json().code, 'pulse.invalid_title');
        assert.strictEqual((await post({ ...base, origin: 'robot' })).json().code, 'pulse.invalid_origin');
        assert.strictEqual((await post({ ...base, occurred_at: '2099-01-01T00:00:00Z' })).json().code, 'pulse.invalid_time');
        assert.strictEqual((await post({ ...base, ref: { service: 'live', type: 'vod' } })).json().code, 'ref.invalid');
        const first = await post({ ...base, occurred_at: '2026-09-20T10:00:00Z' }, { 'x-ov-subject': alex.subject_id });
        assert.strictEqual(first.status, 201);
        const again = await post({ ...base, title: 'A VOD (renamed)', origin: 'ai', occurred_at: '2026-09-21T10:00:00Z' }, { 'x-ov-subject': ids.newId('user') });
        assert.strictEqual(again.status, 200, 'same source: updated, not duplicated');
        const it = again.json().item;
        assert.strictEqual(it.title, 'A VOD (renamed)');
        assert.deepStrictEqual([it.origin, it.actor && it.actor.subject, it.occurred_at], ['user', alex.subject_id, '2026-09-20T10:00:00.000Z'], 'origin, actor and time are the first record\'s');
        assert.strictEqual(items().filter((i) => i.source_id === 'v9').length, 1);
    });

    await check('AI items: labelled AI, never attributed (X-OV-Origin: ai or origin ai), system items name no one', async () => {
        const viaHeader = await call('/api/v1/pulse/items', { method: 'POST', token: svc([PULSE]), headers: { 'x-ov-origin': 'ai', 'x-ov-subject': alex.subject_id }, json: { ref: { service: 'live', type: 'moment', id: 'm1' }, title: 'Chat went wild', url: 'https://openvibe.live/m/1', origin: 'user' } });
        assert.strictEqual(viaHeader.status, 201, viaHeader.text);
        assert.deepStrictEqual([viaHeader.json().item.origin, viaHeader.json().item.actor, viaHeader.json().item.label], ['ai', null, 'AI']);
        const viaBody = await call('/api/v1/pulse/items', { method: 'POST', token: svc([PULSE]), headers: { 'x-ov-subject': alex.subject_id }, json: { ref: { service: 'live', type: 'moment', id: 'm2' }, title: 'Summary', url: 'https://openvibe.live/m/2', origin: 'ai' } });
        assert.deepStrictEqual([viaBody.json().item.origin, viaBody.json().item.actor], ['ai', null]);
        assert.strictEqual(t.db.prepare("SELECT actor_subject FROM pulse_items WHERE source_id = 'm2'").get().actor_subject, null);
        const sys = await call('/api/v1/pulse/items', { method: 'POST', token: svc([PULSE]), headers: { 'x-ov-subject': alex.subject_id }, json: { ref: { service: 'live', type: 'event', id: 'e1' }, title: 'Maintenance tonight', url: 'https://openvibe.live/status', origin: 'system' } });
        assert.deepStrictEqual([sys.json().item.origin, sys.json().item.actor, sys.json().item.label], ['system', null, 'System']);
    });

    await check('GET /api/v1/pulse: newest first, cursor pagination without gaps or repeats, ?origin= filter', async () => {
        for (let i = 0; i < 5; i++) {
            await call('/api/v1/pulse/items', { method: 'POST', token: svc([PULSE]), json: { ref: { service: 'live', type: 'clip', id: `same-time-${i}` }, title: `Tie ${i}`, url: `https://openvibe.live/c/${i}`, occurred_at: '2026-09-21T08:00:00Z' } });
        }
        const all = (await call('/api/v1/pulse?limit=100')).json().items;
        const times = all.map((i) => i.occurred_at);
        assert.deepStrictEqual(times, [...times].sort().reverse(), 'newest first');
        const seen = [];
        let after = '';
        for (let guard = 0; guard < 50; guard++) {
            const page = (await call(`/api/v1/pulse?limit=3${after ? `&after=${encodeURIComponent(after)}` : ''}`)).json();
            seen.push(...page.items.map((i) => i.id));
            if (!page.next_cursor) break;
            after = page.next_cursor;
        }
        assert.deepStrictEqual(seen, all.map((i) => i.id), 'the cursor walks the same list');
        const ai = (await call('/api/v1/pulse?origin=ai')).json().items;
        assert.ok(ai.length === 2 && ai.every((i) => i.origin === 'ai' && i.actor === null));
        assert.strictEqual((await call('/api/v1/pulse?origin=bots')).status, 400);
        assert.strictEqual((await call('/api/v1/pulse?after=garbage')).status, 400);
    });

    await check('DELETE /items/:service/:type/:id retracts only the caller\'s own items', async () => {
        assert.strictEqual((await call('/api/v1/pulse/items/media/object/x', { method: 'DELETE', token: svc([PULSE]) })).status, 403);
        const r = await call('/api/v1/pulse/items/live/clip/c1', { method: 'DELETE', token: svc([PULSE]) });
        assert.deepStrictEqual(r.json(), { removed: 1 });
        assert.ok(!(await call('/api/v1/pulse?limit=100')).json().items.some((i) => i.source.id === 'c1'));
    });

    await check('/pulse renders without JS: AI badge with no person, filters and "Older" as links, noindex deep pages', async () => {
        const r = await t.get('/pulse');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<link rel="canonical" href="https://openvibe.community/pulse">'));
        assert.ok(r.text.includes('<meta name="robots" content="index,follow">'));
        assert.ok(r.text.includes('Chat went wild'));
        assert.ok(r.text.includes('<span class="badge badge-ai" title="Generated by AI — not written by a person">AI</span>'));
        assert.ok(r.text.includes('href="/pulse?origin=ai"'));
        const aiOnly = await t.get('/pulse?origin=ai');
        assert.ok(aiOnly.text.includes('Chat went wild') && !aiOnly.text.includes('A VOD (renamed)'));
        const aiRow = aiOnly.text.slice(aiOnly.text.indexOf('Chat went wild') - 600, aiOnly.text.indexOf('Chat went wild') + 400);
        assert.ok(!aiRow.includes('Alex'), 'an AI item never shows a person');
        assert.ok(r.text.includes('rel="nofollow ugc noopener"'), 'links to other sites are nofollow');
        const small = await t.get('/pulse?origin=user');
        assert.strictEqual(small.status, 200);
        const cursor = (await call('/api/v1/pulse?limit=2')).json().next_cursor;
        const deep = await t.get(`/pulse?after=${encodeURIComponent(cursor)}`);
        assert.ok(deep.text.includes('<meta name="robots" content="noindex,follow">'));
        const bad = await t.get('/pulse?after=nonsense');
        assert.strictEqual(bad.status, 302);
    });

    await t.close();
    done();
})();
