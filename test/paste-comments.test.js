'use strict';
/**
 * Paste comments live on the paste's typed comment thread (community/paste/<slug>): the /p/:slug form,
 * POST /api/pastes/:slug/comments (and a service writing as a person, Live's adapter) and
 * /api/v1/comments all see one thread; private, burned and later-private pastes keep their comments
 * from people who cannot see the paste; migration 0004 copies paste_comments rows onto the threads
 * exactly once, however often it runs.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

const MIGRATION = path.join(__dirname, '..', 'migrations', '0004_paste_comments_to_threads.sql');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 }, appOpts: { commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const kim = net.addUser({ network_user_id: 11, username: 'kim', display_name: 'Kim' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });

    const call = (p, { method = 'GET', token, cookie, headers = {}, json, form } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        return t.get(p, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const create = async (json, cookie = alexJwt) => {
        const r = await call('/api/pastes', { method: 'POST', cookie, json });
        assert.strictEqual(r.status, 201, r.text);
        const out = r.json();
        return out.slug || out.paste.slug;
    };
    const resolve = (slug, who = {}) => call('/api/v1/comments/threads/resolve', { method: 'POST', json: { ref: { service: 'community', type: 'paste', id: slug } }, ...who });
    const legacyRows = async () => Number((await t.db.prepare('SELECT COUNT(*) AS n FROM paste_comments').get()).n);

    const pub = await create({ content: 'public paste', title: 'Pub' });

    await check('the /p/<slug> form and POST /api/pastes/:slug/comments write the typed thread; /api/v1/comments reads both back', async () => {
        const viaForm = await call(`/p/${pub}/comments`, { method: 'POST', cookie: samJwt, form: { message: 'from the page form' } });
        assert.strictEqual(viaForm.status, 303, viaForm.text);
        const m = /^\/p\/([^#]+)#comment-(\d+)$/.exec(viaForm.headers.get('location'));
        assert.ok(m && m[1] === pub, viaForm.headers.get('location'));
        const viaApi = await call(`/api/pastes/${pub}/comments`, { method: 'POST', cookie: alexJwt, json: { message: 'from the paste API' } });
        assert.strictEqual(viaApi.status, 201, viaApi.text);
        assert.strictEqual(viaApi.json().comment.user_id, alex.subject_id);
        // Live's adapter: a service with community.paste.write, writing as a person.
        const viaService = await call(`/api/pastes/${pub}/comments`, { method: 'POST', token: net.signService({ cap: ['community.paste.write'] }), headers: { 'x-ov-subject': kim.subject_id }, json: { message: 'from Live', parent_id: Number(m[2]) } });
        assert.strictEqual(viaService.status, 201, viaService.text);
        assert.strictEqual(viaService.json().comment.parent_id, Number(m[2]));

        const th = (await resolve(pub)).json().thread;
        const got = await call(`/api/v1/comments/threads/${th.id}`);
        assert.strictEqual(got.status, 200, got.text);
        const page = got.json();
        assert.strictEqual(page.thread.comment_count, 3);
        const byMessage = new Map();
        for (const c of page.comments) { byMessage.set(c.message, c); for (const r of c.replies || []) byMessage.set(r.message, r); }
        assert.strictEqual(byMessage.get('from the page form').id, Number(m[2]));
        assert.strictEqual(byMessage.get('from the page form').author.subject, sam.subject_id);
        assert.strictEqual(byMessage.get('from the paste API').id, viaApi.json().comment.id);
        assert.strictEqual(byMessage.get('from Live').parent_id, Number(m[2]));

        const legacy = (await call(`/api/pastes/${pub}/comments`)).json();
        assert.strictEqual(legacy.total, 3);
        assert.deepStrictEqual(legacy.comments.map((c) => c.message), ['from the paste API', 'from the page form'], 'newest top-level first');
        assert.strictEqual(legacy.comments[1].replies[0].message, 'from Live');
        assert.strictEqual(await legacyRows(), 0, 'nothing is written to paste_comments');

        // The paste page shows the same thread: comments with their anchors, sorting, the no-JS form.
        const pageHtml = await call(`/p/${pub}`, { cookie: samJwt });
        assert.strictEqual(pageHtml.status, 200);
        for (const want of ['from the page form', 'from the paste API', 'from Live', `id="comment-${m[2]}"`, `id="comment-${viaApi.json().comment.id}"`,
            `action="/p/${pub}/comments"`, `href="/p/${pub}?sort=old"`]) assert.ok(pageHtml.text.includes(want), want);
        assert.ok(pageHtml.text.indexOf('from the paste API') < pageHtml.text.indexOf('from the page form'), 'newest first');
        const oldest = await call(`/p/${pub}?sort=old`);
        assert.ok(oldest.text.indexOf('from the page form') < oldest.text.indexOf('from the paste API'), '?sort=old: oldest first');
        assert.ok(oldest.text.includes(`/auth/login?next=${encodeURIComponent(`/p/${pub}`)}`) && !oldest.text.includes(`action="/p/${pub}/comments"`), 'signed out: a sign-in link, no form');
        const older = await call(`/p/${pub}?sort=new&after=${viaApi.json().comment.id}`);
        assert.ok(older.text.includes('from the page form') && !older.text.includes('from the paste API'), 'paged with ?after=');

        // Deleting a comment twice succeeds both times, as before.
        const del = await call(`/api/pastes/${pub}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'short-lived' } });
        for (let i = 0; i < 2; i++) assert.strictEqual((await call(`/api/pastes/${pub}/comments/${del.json().comment.id}`, { method: 'DELETE', cookie: samJwt })).status, 200);
        assert.ok(!(await call(`/p/${pub}`)).text.includes('short-lived'));
    });

    await check('the form: signed in only, never from another site', async () => {
        const anon = await call(`/p/${pub}/comments`, { method: 'POST', form: { message: 'hi' } });
        assert.strictEqual(anon.status, 303);
        assert.strictEqual(anon.headers.get('location'), `/auth/login?next=${encodeURIComponent(`/p/${pub}`)}`);
        const foreign = await call(`/p/${pub}/comments`, { method: 'POST', cookie: samJwt, headers: { origin: 'https://evil.example' }, form: { message: 'hi' } });
        assert.strictEqual(foreign.status, 403);
        const empty = await call(`/p/${pub}/comments`, { method: 'POST', cookie: samJwt, form: { message: '   ' } });
        assert.strictEqual(empty.status, 400);
        assert.strictEqual((await call('/p/no-such-paste-here/comments', { method: 'POST', cookie: samJwt, form: { message: 'hi' } })).status, 404);
    });

    await check('a private paste\'s comments stay with its owner: the paste API, resolve, the thread\'s access id and the form', async () => {
        const priv = await create({ content: 'private paste', visibility: 'private' });
        assert.strictEqual((await call(`/api/pastes/${priv}/comments`, { method: 'POST', cookie: alexJwt, json: { message: 'owner only note' } })).status, 201);
        const own = (await resolve(priv, { cookie: alexJwt })).json().thread;
        assert.ok(own && /^cth_/.test(own.id));
        assert.ok((await call(`/api/v1/comments/threads/${own.id}`, { cookie: alexJwt })).text.includes('owner only note'));
        for (const who of [{ cookie: samJwt }, {}]) {
            const list = await call(`/api/pastes/${priv}/comments`, who);
            assert.strictEqual(list.status, 404);
            assert.ok(!list.text.includes('owner only note'));
            assert.strictEqual((await resolve(priv, who)).status, 404);
            const leaked = await call(`/api/v1/comments/threads/${own.id}`, who);
            assert.strictEqual(leaked.status, 404, 'even with the access id');
            assert.ok(!leaked.text.includes('owner only note'));
            assert.strictEqual((await call(`/c/${own.id}`, who)).status, 404);
        }
        assert.ok((await call(`/p/${priv}`, { cookie: alexJwt })).text.includes('owner only note'), 'the owner sees them on the paste page');
        for (const who of [{ cookie: samJwt }, {}]) assert.ok(!(await call(`/p/${priv}`, who)).text.includes('owner only note'));
        assert.strictEqual((await call(`/p/${priv}/comments`, { method: 'POST', cookie: samJwt, form: { message: 'let me in' } })).status, 404);
        assert.strictEqual((await call(`/api/pastes/${priv}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'let me in' } })).status, 404);
    });

    await check('an unlisted paste made private later, and a burned paste, take their thread with them', async () => {
        const unl = await create({ content: 'unlisted paste', visibility: 'unlisted' });
        const th = (await resolve(unl, { cookie: samJwt })).json().thread;
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'seen by link' } })).status, 201);
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}`, { cookie: samJwt })).status, 200);
        assert.strictEqual((await call(`/api/pastes/${unl}`, { method: 'PUT', cookie: alexJwt, json: { visibility: 'private' } })).status, 200);
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/api/v1/comments/threads/${th.id}`, { cookie: alexJwt })).status, 200, 'the owner still sees it');

        const burn = await create({ content: 'read me once', burn_after_read: true });
        const bth = (await resolve(burn, { cookie: samJwt })).json().thread;
        assert.strictEqual((await call(`/api/v1/comments/threads/${bth.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'before the burn' } })).status, 201);
        assert.strictEqual((await call(`/api/pastes/${burn}`, { cookie: samJwt })).status, 200);
        assert.strictEqual((await call(`/api/pastes/${burn}`, { cookie: samJwt })).status, 410, 'burned');
        for (const who of [{ cookie: samJwt }, { cookie: alexJwt }, {}]) {
            const r = await call(`/api/v1/comments/threads/${bth.id}`, who);
            assert.strictEqual(r.status, 404);
            assert.ok(!r.text.includes('before the burn'));
        }
    });

    await check('migration 0004 copies paste_comments onto the thread once, however often it runs', async () => {
        const slug = await create({ content: 'a paste from before' });
        const pid = (await t.db.prepare('SELECT id FROM pastes WHERE slug = ?').get(slug)).id;
        // Rows as the old paste API left them: a comment, a reply to it, an anonymous one, a deleted one.
        await t.db.prepare(`INSERT INTO paste_comments (paste_id, author_subject, anon_name, parent_id, message, is_deleted, created_at, updated_at) VALUES
            (?, ?, NULL, NULL, 'old comment', 0, '2025-01-02 03:04:05', '2025-01-02 03:04:05')`).run(pid, sam.subject_id);
        const top = (await t.db.prepare("SELECT id FROM paste_comments WHERE message = 'old comment'").get()).id;
        await t.db.prepare(`INSERT INTO paste_comments (paste_id, author_subject, anon_name, parent_id, message, is_deleted, created_at, updated_at) VALUES
            (?, ?, NULL, ?, 'old reply', 0, '2025-01-02 04:00:00', '2025-01-02 04:00:00'),
            (?, NULL, 'Visitor', NULL, 'old anonymous', 0, '2025-01-03 00:00:00', '2025-01-03 00:00:00'),
            (?, ?, NULL, NULL, 'old deleted', 1, '2025-01-04 00:00:00', '2025-01-05 00:00:00')`).run(pid, alex.subject_id, top, pid, pid, sam.subject_id);
        const legacy = await t.db.prepare('SELECT * FROM paste_comments WHERE paste_id = ? ORDER BY id').all(pid);
        assert.strictEqual(legacy.length, 4);

        const sql = fs.readFileSync(MIGRATION, 'utf8');
        await t.db.exec(sql);
        await t.db.exec(sql);

        const mapped = await t.db.prepare("SELECT source_id, target_id FROM legacy_id_map WHERE source_system = 'community' AND source_type = 'paste_comment'").all();
        assert.strictEqual(mapped.length, Number((await t.db.prepare('SELECT COUNT(*) AS n FROM paste_comments').get()).n), 'one map row per paste_comments row');
        const newId = new Map(mapped.map((r) => [Number(r.source_id), Number(r.target_id)]));
        const threads = await t.db.prepare("SELECT * FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'paste' AND ref_id = ?").all(slug);
        assert.strictEqual(threads.length, 1);
        assert.match(threads[0].access_id, /^cth_[A-Za-z0-9_-]{22}$/);
        const copied = await t.db.prepare('SELECT * FROM comments WHERE thread_id = ? ORDER BY id').all(threads[0].id);
        assert.strictEqual(copied.length, 4, 'each row copied exactly once');
        for (const old of legacy) {
            const c = copied.find((x) => Number(x.id) === newId.get(Number(old.id)));
            assert.ok(c, `row ${old.id} copied`);
            assert.strictEqual(c.author_subject, old.author_subject);
            assert.strictEqual(c.anon_name, old.anon_name);
            assert.strictEqual(c.created_at, old.created_at);
            assert.strictEqual(c.origin, 'user');
            assert.strictEqual(c.parent_id == null ? null : Number(c.parent_id), old.parent_id == null ? null : newId.get(Number(old.parent_id)));
            if (Number(old.is_deleted)) { assert.strictEqual(c.deleted_at, old.updated_at); assert.strictEqual(c.message, ''); } else { assert.strictEqual(c.deleted_at, null); assert.strictEqual(c.message, old.message); }
        }
        assert.strictEqual(Number(threads[0].comment_count), 3);
        assert.strictEqual(Number(copied.find((x) => Number(x.id) === newId.get(Number(top))).reply_count), 1);

        // Served from the thread, by the paste API and the comments API alike; new comments get new ids.
        const list = (await call(`/api/pastes/${slug}/comments`)).json();
        assert.strictEqual(list.total, 3);
        assert.deepStrictEqual(list.comments.map((c) => c.message), ['old anonymous', 'old comment']);
        assert.strictEqual(list.comments[1].replies[0].message, 'old reply');
        const fresh = await call(`/api/pastes/${slug}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'after the move', parent_id: newId.get(Number(top)) } });
        assert.strictEqual(fresh.status, 201, fresh.text);
        assert.ok(fresh.json().comment.id > Math.max(...newId.values()));
        const page = (await call(`/api/v1/comments/threads/${threads[0].access_id}`)).json();
        assert.strictEqual(page.thread.comment_count, 4);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
