'use strict';
/**
 * Native /api/pastes (PASTES_AUTHORITY=community): who may call what.
 * Browser JWTs, anonymous callers and service tokens (capabilities, X-OV-Subject / X-OV-Origin /
 * X-OV-Source-Ref / X-OV-Staff), the AI work queue, the anonymous write limit, author display via
 * the Network's resolve-batch, screenshot uploads to Media, raw text and screenshot links.
 */
const assert = require('assert');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex', avatar_url: 'https://openvibe.media/avatars/alex.png' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const kim = net.addUser({ network_user_id: 11, username: 'kim', display_name: 'Kim', avatar_url: '/avatar/kim' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user', profile_color: '#0af' });
    const samOldJwt = net.sign({ id: 9, username: 'sam', display_name: 'Sam', role: 'user' }); // pre-subject_id token
    const adminJwt = net.sign({ id: 1, subject_id: ids.newId('user'), username: 'boss', display_name: 'Boss', role: 'admin' });
    const svc = (cap, extra = {}) => net.signService({ cap, ...extra });
    const CREATE = 'community.paste.create', WRITE = 'community.paste.write', MOD = 'community.paste.moderate';

    const call = (path, { method = 'GET', token, cookie, headers = {}, json, body, ip } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (ip) h['x-forwarded-for'] = ip;
        let b = body;
        if (json !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body: b, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };

    let alexSlug;

    await check('browser create: owner from the JWT subject; body identity fields and X-OV-* headers ignored', async () => {
        const r = await call('/api/pastes', {
            method: 'POST', cookie: alexJwt, ip: '192.0.2.10',
            headers: { 'x-ov-subject': sam.subject_id, 'x-ov-origin': 'ai' },
            json: { title: 'Mine', content: 'print(1)', language: 'python', user_id: 9, owner_subject: sam.subject_id, author_id: 9, origin: 'ai', slug: 'my-chosen-slug' },
        });
        assert.strictEqual(r.status, 201, r.text);
        const out = r.json();
        assert.ok(out.id && out.slug && out.url === `/p/${out.slug}` && out.paste);
        assert.notStrictEqual(out.slug, 'my-chosen-slug', 'browsers never pick slugs');
        assert.strictEqual(out.paste.owner_subject, alex.subject_id);
        assert.strictEqual(out.paste.origin, 'user');
        assert.strictEqual(out.paste.username, 'alex');
        assert.strictEqual(out.paste.profile_color, '#0af', 'JWT claims feed the projection');
        alexSlug = out.slug;
    });

    await check('an older JWT without subject_id is resolved through the Network once, then cached', async () => {
        const before = net.resolveCalls.length;
        const r = await call('/api/pastes', { method: 'POST', token: samOldJwt, json: { content: 'hello from sam' } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().paste.owner_subject, sam.subject_id);
        const lookups = net.resolveCalls.slice(before);
        assert.deepStrictEqual(lookups[0], { system: 'network', type: 'user', ids: ['9'] });
        await call('/api/pastes', { method: 'POST', token: samOldJwt, json: { content: 'again' } });
        assert.strictEqual(net.resolveCalls.slice(before).filter((b) => b.system === 'network').length, 1, 'cached in legacy_id_map');
        const grant = net.grants.find((g) => g.grant_type === 'client_credentials' && g.audience === 'openvibe.network');
        assert.strictEqual(grant.scope, 'identity.subject.resolve');
    });

    await check('service token: create as the acting subject (X-OV-Subject)', async () => {
        const r = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), headers: { 'x-ov-subject': alex.subject_id }, json: { content: 'via live', user_id: 9 } });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().paste.owner_subject, alex.subject_id);
    });

    await check('service token denials: wrong audience, bad signature, expired, missing capability, bad X-OV-Subject', async () => {
        const wrongAud = await call('/api/pastes', { method: 'POST', token: svc([CREATE], { aud: ['openvibe.live'] }), json: { content: 'x' } });
        assert.strictEqual(wrongAud.status, 401);
        assert.strictEqual(wrongAud.json().code, 'token.wrong_audience');
        assert.match(wrongAud.headers.get('content-type'), /application\/problem\+json/);
        const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
        const forged = await call('/api/pastes', { method: 'POST', token: svc([CREATE], { key: otherKey }), json: { content: 'x' } });
        assert.strictEqual(forged.status, 401);
        assert.strictEqual(forged.json().code, 'token.bad_signature');
        const expired = await call('/api/pastes', { token: svc([CREATE], { expSec: -120 }) });
        assert.strictEqual(expired.json().code, 'token.expired');
        const noCap = await call('/api/pastes', { method: 'POST', token: svc([WRITE]), json: { content: 'x' } });
        assert.strictEqual(noCap.status, 403);
        assert.strictEqual(noCap.json().code, 'capability.denied');
        const noPasteCaps = await call('/api/pastes', { token: svc(['chat.message.send']) });
        assert.strictEqual(noPasteCaps.status, 403, 'a token for something else is not a pass to read as someone');
        const badSubject = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), headers: { 'x-ov-subject': '7' }, json: { content: 'x' } });
        assert.strictEqual(badSubject.status, 400);
        assert.strictEqual(badSubject.json().code, 'subject.invalid');
        const badRef = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), headers: { 'x-ov-source-ref': '{"service":"live"}' }, json: { content: 'x' } });
        assert.strictEqual(badRef.status, 400);
    });

    await check('service without X-OV-Subject writes anonymously; X-OV-Origin: ai → origin ai, no owner, stream ref kept', async () => {
        const anon = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), json: { content: 'nobody' } });
        assert.strictEqual(anon.json().paste.owner_subject, null);
        assert.strictEqual(anon.json().paste.origin, 'user');
        const ref = { service: 'live', type: 'stream', id: '42' };
        const ai = await call('/api/pastes', {
            method: 'POST', token: svc([CREATE]),
            headers: { 'x-ov-origin': 'ai', 'x-ov-subject': alex.subject_id, 'x-ov-source-ref': JSON.stringify(ref) },
            json: { title: 'A wild moment', content: 'the chat exploded', slug: 'wild-moment-4242', metadata: { ai_moment: true, stream_id: 42 }, ai_summary: 'chat exploded', ai_tags: ['hype'] },
        });
        assert.strictEqual(ai.status, 201, ai.text);
        const p = ai.json().paste;
        assert.strictEqual(p.slug, 'wild-moment-4242', 'services may bring their own slug');
        assert.strictEqual(p.origin, 'ai');
        assert.strictEqual(p.owner_subject, null, 'AI output is never attributed to a person');
        assert.strictEqual(p.user_id, null);
        assert.strictEqual(p.display_name, 'OpenVibe AI');
        assert.deepStrictEqual(p.stream_ref, ref);
        assert.strictEqual(p.stream_id, 42);
        assert.deepStrictEqual(JSON.parse(p.metadata), { ai_moment: true, stream_id: 42 });
        assert.strictEqual(p.ai_summary, 'chat exploded');
        const dup = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), json: { content: 'y', slug: 'wild-moment-4242' } });
        assert.strictEqual(dup.status, 409);
        const bad = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), json: { content: 'y', slug: 'config' } });
        assert.strictEqual(bad.status, 400);
        const onlyAi = (await call('/api/pastes?origin=ai')).json();
        assert.ok(onlyAi.pastes.length >= 1 && onlyAi.pastes.every((x) => x.origin === 'ai'));
        const browserMeta = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'meta?', metadata: { ai_moment: true } } });
        assert.strictEqual(browserMeta.json().paste.metadata, null, 'browsers cannot set metadata');
    });

    await check('write capability: edits as the acting subject are owner-checked by Community', async () => {
        const asAlex = await call(`/api/pastes/${alexSlug}`, { method: 'PUT', token: svc([WRITE]), headers: { 'x-ov-subject': alex.subject_id }, json: { title: 'Edited via Live' } });
        assert.strictEqual(asAlex.status, 200, asAlex.text);
        assert.strictEqual(asAlex.json().paste.title, 'Edited via Live');
        const asSam = await call(`/api/pastes/${alexSlug}`, { method: 'PUT', token: svc([WRITE]), headers: { 'x-ov-subject': sam.subject_id }, json: { title: 'hijack' } });
        assert.strictEqual(asSam.status, 403);
        assert.deepStrictEqual(asSam.json(), { error: 'Not authorized for this paste' });
        const noSubject = await call(`/api/pastes/${alexSlug}`, { method: 'DELETE', token: svc([WRITE]) });
        assert.strictEqual(noSubject.status, 401);
        const createOnly = await call(`/api/pastes/${alexSlug}`, { method: 'PUT', token: svc([CREATE]), headers: { 'x-ov-subject': alex.subject_id }, json: { title: 'x' } });
        assert.strictEqual(createOnly.status, 403);
        assert.strictEqual(createOnly.json().code, 'capability.denied');
    });

    await check('staff: X-OV-Staff needs community.paste.moderate; with it a service may delete anyone\'s comment', async () => {
        const c = (await call(`/api/pastes/${alexSlug}/comments`, { method: 'POST', token: samOldJwt, json: { message: 'spam spam' } })).json().comment;
        assert.strictEqual(c.username, 'sam');
        const notStaff = await call(`/api/pastes/${alexSlug}/comments/${c.id}`, { method: 'DELETE', token: svc([WRITE]), headers: { 'x-ov-subject': kim.subject_id } });
        assert.strictEqual(notStaff.status, 403);
        const fakeStaff = await call(`/api/pastes/${alexSlug}/comments/${c.id}`, { method: 'DELETE', token: svc([WRITE]), headers: { 'x-ov-staff': '1' } });
        assert.strictEqual(fakeStaff.status, 403);
        assert.strictEqual(fakeStaff.json().code, 'capability.denied');
        const staff = await call(`/api/pastes/${alexSlug}/comments/${c.id}`, { method: 'DELETE', token: svc([WRITE, MOD]), headers: { 'x-ov-staff': '1', 'x-ov-subject': kim.subject_id } });
        assert.strictEqual(staff.status, 200, staff.text);
        assert.deepStrictEqual(staff.json(), { message: 'Comment deleted' });
        const bulkUser = await call('/api/pastes/bulk', { method: 'POST', cookie: alexJwt, json: { slugs: [alexSlug], action: 'private' } });
        assert.strictEqual(bulkUser.status, 403);
        const bulkAdmin = await call('/api/pastes/admin/stats', { cookie: adminJwt });
        assert.strictEqual(bulkAdmin.status, 200);
        assert.ok(bulkAdmin.json().stats.total > 0);
        const bulkSvc = await call('/api/pastes/admin/stats', { token: svc([WRITE]) });
        assert.strictEqual(bulkSvc.status, 403);
    });

    await check('AI work queue: needs_ai + POST /:slug/ai for moderate service tokens only', async () => {
        const hidden = (await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'hidden work', visibility: 'private' } })).json().slug;
        const q = await call('/api/pastes?needs_ai=1&limit=200', { token: svc([MOD]) });
        assert.strictEqual(q.status, 200, q.text);
        const queue = q.json().pastes.map((p) => p.slug);
        assert.ok(queue.includes(hidden), 'the queue spans visibility');
        assert.ok(!queue.includes('wild-moment-4242'), 'already annotated');
        for (const who of [{ cookie: adminJwt }, {}, { token: svc([WRITE, CREATE]) }]) {
            const denied = await call('/api/pastes?needs_ai=1', who);
            assert.strictEqual(denied.status, 403, `needs_ai refused for ${JSON.stringify(Object.keys(who))}`);
            const write = await call(`/api/pastes/${hidden}/ai`, { method: 'POST', json: { ai_summary: 'x' }, ...who });
            assert.strictEqual(write.status, 403);
        }
        const w = await call(`/api/pastes/${hidden}/ai`, { method: 'POST', token: svc([MOD]), json: { ai_summary: 'a secret note', ai_tags: ['notes', 'private'] } });
        assert.strictEqual(w.status, 200, w.text);
        assert.strictEqual(w.json().ok, true);
        assert.strictEqual(w.json().paste.ai_summary, 'a secret note');
        assert.strictEqual(w.json().paste.ai_tags, '["notes","private"]');
        assert.ok(w.json().paste.ai_analyzed_at);
        const again = (await call('/api/pastes?needs_ai=1&limit=200', { token: svc([MOD]) })).json().pastes.map((p) => p.slug);
        assert.ok(!again.includes(hidden));
    });

    await check('author display: unknown subjects are resolved through resolve-batch; stale ones refresh', async () => {
        const before = net.resolveCalls.length;
        const r = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), headers: { 'x-ov-subject': kim.subject_id }, json: { content: 'kim was here' } });
        const p = r.json().paste;
        assert.strictEqual(p.username, 'kim');
        assert.strictEqual(p.display_name, 'Kim');
        assert.strictEqual(p.avatar_url, `${net.url}/avatar/kim`, 'relative Network avatars made absolute');
        assert.ok(net.resolveCalls.slice(before).some((b) => Array.isArray(b.subject_ids) && b.subject_ids.includes(kim.subject_id)));
        kim.display_name = 'Kim Renamed';
        t.db.prepare("UPDATE subject_projection SET refreshed_at = datetime('now', '-1 day') WHERE subject_id = ?").run(kim.subject_id);
        const stale = await call(`/api/pastes/${p.slug}?no_view=1`);
        assert.strictEqual(stale.json().paste.display_name, 'Kim', 'stale entry served while it refreshes');
        await new Promise((res) => setTimeout(res, 100));
        const fresh = await call(`/api/pastes/${p.slug}?no_view=1`);
        assert.strictEqual(fresh.json().paste.display_name, 'Kim Renamed');
        net.directory.down = true;
        const ghost = ids.newId('user');
        const down = await call('/api/pastes', { method: 'POST', token: svc([CREATE]), headers: { 'x-ov-subject': ghost }, json: { content: 'network down' } });
        assert.strictEqual(down.status, 201, 'a Network outage costs names, not the write');
        assert.strictEqual(down.json().paste.username, null);
        net.directory.down = false;
    });

    await check('anonymous writes: 20 per 10 minutes per address; signed-in and other addresses unaffected', async () => {
        const ip = '203.0.113.77';
        for (let i = 0; i < 20; i++) {
            const r = await call('/api/pastes', { method: 'POST', ip, json: { content: `anon ${i}` } });
            assert.strictEqual(r.status, 201, `#${i}: ${r.text}`);
        }
        const over = await call('/api/pastes', { method: 'POST', ip, json: { content: 'one too many' } });
        assert.strictEqual(over.status, 429);
        assert.deepStrictEqual(over.json(), { error: 'Too many anonymous posts — sign in or try again later' });
        const comment = await call(`/api/pastes/${alexSlug}/comments`, { method: 'POST', ip, json: { message: 'also limited' } });
        assert.strictEqual(comment.status, 429, 'comments share the budget');
        assert.strictEqual((await call('/api/pastes', { method: 'POST', ip, cookie: alexJwt, json: { content: 'signed in' } })).status, 201);
        assert.strictEqual((await call('/api/pastes', { method: 'POST', ip: '203.0.113.78', json: { content: 'elsewhere' } })).status, 201);
        assert.strictEqual((await call('/api/pastes', { method: 'POST', ip, token: svc([CREATE]), json: { content: 'service' } })).status, 201);
    });

    // A JPEG whose APP1 segment carries EXIF (with a fake GPS marker).
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'),
        Buffer.from([0xff, 0xe1, 0x00, 0x17]), Buffer.from('Exif\0\0GPS-51.5N-0.12W', 'latin1'),
        Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
        Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.from('pixels', 'latin1'), Buffer.from([0xff, 0xd9]),
    ]);
    let shotSlug;

    await check('screenshot upload: metadata stripped, bytes stored in Media with a service token, URL + media_ref kept', async () => {
        const fd = new FormData();
        fd.append('title', 'My desk');
        fd.append('description', 'look');
        fd.append('page_url', 'https://example.com/x');
        fd.append('user_id', '9');
        fd.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 'desk.jpg');
        const r = await call('/api/pastes/screenshot', { method: 'POST', cookie: alexJwt, body: fd });
        assert.strictEqual(r.status, 201, r.text);
        const out = r.json();
        const up = t.media.uploads[t.media.uploads.length - 1];
        assert.ok(!up.bytes.includes(Buffer.from('GPS')), 'EXIF never leaves Community');
        assert.ok(up.bytes.includes(Buffer.from('pixels')) && up.bytes.includes(Buffer.from('JFIF')));
        assert.strictEqual(up.mime, 'image/jpeg');
        assert.ok(up.claims.cap.includes('media.object.upload'));
        const p = out.paste;
        assert.strictEqual(out.slug, p.slug);
        assert.strictEqual(p.type, 'screenshot');
        assert.strictEqual(p.owner_subject, alex.subject_id);
        assert.strictEqual(p.screenshot_url, `https://openvibe.media/f/${up.key}`);
        assert.strictEqual(p.title, 'My desk');
        assert.strictEqual(p.content, 'look');
        const meta = JSON.parse(p.metadata);
        assert.strictEqual(meta.page_url, 'https://example.com/x');
        assert.strictEqual(meta.original_name, 'desk.jpg');
        const row = t.db.prepare('SELECT media_ref FROM pastes WHERE slug = ?').get(p.slug);
        assert.strictEqual(row.media_ref, `legacy:community:file:${up.key}`);
        shotSlug = p.slug;
        const viaCreate = new FormData();
        viaCreate.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 'b.jpg');
        const r2 = await call('/api/pastes', { method: 'POST', cookie: alexJwt, body: viaCreate });
        assert.strictEqual(r2.status, 201, 'multipart POST / creates a screenshot paste too');
        assert.strictEqual(r2.json().paste.title, 'Screenshot');
        const bad = new FormData();
        bad.append('screenshot', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
        assert.strictEqual((await call('/api/pastes/screenshot', { method: 'POST', cookie: alexJwt, body: bad })).status, 400);
        t.media.failNext();
        const again = new FormData();
        again.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 'c.jpg');
        const failed = await call('/api/pastes/screenshot', { method: 'POST', cookie: alexJwt, body: again });
        assert.strictEqual(failed.status, 502);
        assert.deepStrictEqual(failed.json(), { error: 'Media service unavailable' });
    });

    await check('/p/:slug/raw is served from the store (nosniff, private rules); /p/:slug/screenshot → stored URL', async () => {
        const raw = await call(`/p/${alexSlug}/raw`);
        assert.strictEqual(raw.status, 200);
        assert.strictEqual(raw.headers.get('content-type'), 'text/plain; charset=utf-8');
        assert.strictEqual(raw.headers.get('x-content-type-options'), 'nosniff');
        assert.strictEqual(raw.text, 'print(1)');
        const priv = (await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'eyes only', visibility: 'private' } })).json().slug;
        assert.strictEqual((await call(`/p/${priv}/raw`)).status, 404);
        assert.strictEqual((await call(`/p/${priv}/raw`, { cookie: alexJwt })).text, 'eyes only');
        const api = await call(`/api/pastes/${alexSlug}/raw`);
        assert.strictEqual(api.status, 302);
        assert.strictEqual(api.headers.get('location'), `/p/${alexSlug}/raw`);
        const shot = await call(`/p/${shotSlug}/screenshot`);
        assert.strictEqual(shot.status, 302);
        assert.match(shot.headers.get('location'), /^https:\/\/openvibe\.media\/f\//);
        assert.strictEqual((await call(`/p/${shotSlug}/raw`)).headers.get('location'), `/p/${shotSlug}/screenshot`);
        assert.strictEqual((await call(`/p/${alexSlug}/screenshot`)).status, 404);
        const burn = (await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'once', burn_after_read: true } })).json().slug;
        assert.strictEqual((await call(`/p/${burn}/raw`)).text, 'once');
        assert.strictEqual((await call(`/p/${burn}/raw`)).status, 410);
    });

    await check('likes need a person; comments allow anonymous names; set-avatar is the Network\'s; unknown routes 404', async () => {
        const like = await call(`/api/pastes/${alexSlug}/like`, { method: 'POST' });
        assert.strictEqual(like.status, 401);
        assert.deepStrictEqual(like.json(), { error: 'Authentication required' });
        const liked = await call(`/api/pastes/${alexSlug}/like`, { method: 'POST', token: samOldJwt });
        assert.deepStrictEqual(liked.json(), { liked: true, likes: 1 });
        const viaSvc = await call(`/api/pastes/${alexSlug}/like`, { method: 'POST', token: svc([WRITE]), headers: { 'x-ov-subject': kim.subject_id } });
        assert.deepStrictEqual(viaSvc.json(), { liked: true, likes: 2 });
        const c = await call(`/api/pastes/${alexSlug}/comments`, { method: 'POST', ip: '198.51.100.40', json: { message: 'nice', anon_name: 'Visitor' } });
        assert.strictEqual(c.status, 201, c.text);
        assert.strictEqual(c.json().comment.anon_name, 'Visitor');
        const list = (await call(`/api/pastes/${alexSlug}/comments`)).json();
        assert.ok(list.comments.some((x) => x.message === 'nice' && x.user_id === null));
        assert.strictEqual((await call(`/api/pastes/${alexSlug}/comments/${c.json().comment.id}`, { method: 'DELETE' })).status, 401);
        assert.strictEqual((await call(`/api/pastes/${alexSlug}/set-avatar`, { method: 'POST', cookie: alexJwt })).status, 501);
        assert.strictEqual((await call(`/api/pastes/${alexSlug}/nope/deeper`)).status, 404);
        const cfg = (await call('/api/pastes/config', { cookie: alexJwt })).json();
        assert.strictEqual(cfg.maxSizeKb, 512);
        assert.ok(cfg.todayCount > 0);
        const malformed = await call('/api/pastes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
        assert.strictEqual(malformed.status, 400);
    });

    await t.close();
    done();
})();
