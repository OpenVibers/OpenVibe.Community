'use strict';
/**
 * Paste store + service semantics on an in-memory database (no HTTP): create/get/list,
 * visibility, burn-after-read, forks, likes, copies, comments and replies, deletes, versions,
 * limits and view counting.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { openDb } = require('../server/db');
const store = require('../server/pastes/store');
const { createPasteService, PasteError } = require('../server/pastes/service');
const { check, done } = require('./helpers/app');

const db = openDb(':memory:');
const svc = createPasteService({ db, config: { oauth: { clientSecret: 'test' } }, limits: { cooldownSeconds: 0 } });

const alice = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
const bob = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
const mod = { kind: 'user', subject: ids.newId('user'), staff: true, origin: 'user' };
const anon = { kind: 'anonymous', subject: null, staff: false, origin: 'user' };
store.upsertProjection(db, { subject_id: alice.subject, username: 'alice', display_name: 'Alice', avatar_url: 'https://openvibe.media/a.png', profile_color: '#f0a' });

async function rejects(p, status, message) {
    try { await p; } catch (err) {
        assert.ok(err instanceof PasteError, `expected PasteError, got ${err && err.stack}`);
        assert.strictEqual(err.status, status, `status: ${JSON.stringify(err.body)}`);
        if (message) assert.strictEqual(err.body.error, message);
        return err;
    }
    throw new Error(`expected ${status}`);
}

(async () => {
    let pub, unl, priv;

    await check('create: slug style, trimmed content, language detection, owner, Media response shape', async () => {
        const out = await svc.createText(alice, { title: '  Hello  ', content: 'const x = 1;\n  ', language: 'auto', visibility: 'public' });
        assert.match(out.slug, /^[a-z]+-[a-z]+-\d{2}$/);
        assert.deepStrictEqual(Object.keys(out), ['id', 'slug', 'url', 'paste']);
        assert.strictEqual(out.url, `/p/${out.slug}`);
        const p = out.paste;
        assert.strictEqual(p.title, 'Hello');
        assert.strictEqual(p.content, 'const x = 1;');
        assert.strictEqual(p.language, 'javascript');
        assert.strictEqual(p.owner_subject, alice.subject);
        assert.strictEqual(p.user_id, alice.subject, 'user_id carries the subject id');
        assert.strictEqual(p.origin, 'user');
        assert.strictEqual(p.username, 'alice');
        assert.strictEqual(p.display_name, 'Alice');
        assert.strictEqual(p.avatar_url, 'https://openvibe.media/a.png');
        assert.strictEqual(p.profile_color, '#f0a');
        assert.strictEqual(p.raw_url, `/p/${out.slug}/raw`);
        assert.strictEqual(p.is_owner, true);
        for (const k of ['views', 'copies', 'likes', 'unique_views']) assert.strictEqual(p[k], 0);
        pub = out.slug;
        unl = (await svc.createText(alice, { title: 'unl', content: 'u', visibility: 'unlisted' })).slug;
        priv = (await svc.createText(alice, { title: 'priv', content: 'p', visibility: 'private' })).slug;
    });

    await check('create: validation errors match Media', async () => {
        await rejects(svc.createText(alice, { content: '   ' }), 400, 'Content is required');
        await rejects(svc.createText(alice, { content: 'x'.repeat(512 * 1024 + 1) }), 400, 'Paste too large (max 512 KB)');
        const untitled = await svc.createText(alice, { content: 'y' });
        assert.strictEqual(untitled.paste.title, 'Untitled');
        // An anonymous private paste could never be opened: it becomes unlisted.
        const anonPriv = await svc.createText(anon, { content: 'z', visibility: 'private' });
        assert.strictEqual(anonPriv.paste.visibility, 'unlisted');
        assert.strictEqual(anonPriv.paste.owner_subject, null);
        assert.strictEqual(anonPriv.paste.user_id, null);
    });

    await check('visibility: public listed; unlisted by slug only; private owner/staff only (404 otherwise)', async () => {
        const list = await svc.list(anon, { limit: 50 });
        const slugs = list.pastes.map((p) => p.slug);
        assert.ok(slugs.includes(pub));
        assert.ok(!slugs.includes(unl) && !slugs.includes(priv));
        assert.strictEqual((await svc.get(bob, unl, { noView: true })).paste.slug, unl);
        await rejects(svc.get(bob, priv), 404, 'Paste not found');
        await rejects(svc.get(anon, priv), 404, 'Paste not found');
        assert.strictEqual((await svc.get(alice, priv)).paste.visibility, 'private');
        assert.strictEqual((await svc.get(mod, priv, { noView: true })).paste.visibility, 'private');
        // Private pastes can't be forked, liked, copied or commented by others either.
        await rejects(svc.fork(bob, priv), 404);
        await rejects(Promise.resolve().then(() => svc.like(bob, priv)), 404);
        await rejects(Promise.resolve().then(() => svc.copy(anon, priv)), 404);
        await rejects(svc.comments(anon, priv), 404);
    });

    await check('list: preview content (300 chars, null for screenshots), filters, owner view via username', async () => {
        const long = await svc.createText(bob, { title: 'long one', content: 'L'.repeat(1000) });
        store.upsertProjection(db, { subject_id: bob.subject, username: 'bob', display_name: 'Bob' });
        const list = await svc.list(anon, { search: 'long one' });
        assert.strictEqual(list.total, 1);
        assert.strictEqual(list.pastes[0].content.length, 300);
        assert.deepStrictEqual(Object.keys(list).sort(), ['limit', 'offset', 'pastes', 'total']);
        const mine = await svc.list(alice, { username: 'alice', include_unlisted: '1', limit: 100 });
        assert.ok(mine.pastes.some((p) => p.slug === priv), 'owner sees own private with include_unlisted');
        const theirs = await svc.list(bob, { username: 'alice', include_unlisted: '1', limit: 100 });
        assert.ok(!theirs.pastes.some((p) => p.slug === priv || p.slug === unl), 'others never do');
        assert.deepStrictEqual(await svc.list(anon, { username: 'nobody' }), { pastes: [], total: 0, limit: 0, offset: 0, hasMore: false });
        const wildcard = await svc.list(anon, { search: '%' });
        assert.strictEqual(wildcard.total, 0, 'LIKE wildcards are literal');
        assert.strictEqual((await svc.list(anon, { limit: 1 })).pastes.length, 1);
        assert.strictEqual(long.paste.username, null, 'no projection yet at creation → no name (not a crash)');
    });

    await check('by-user: 404 for unknown, own hidden pastes only for the owner', async () => {
        await rejects(svc.byUser(anon, 'ghost'), 404, 'User not found');
        const self = await svc.byUser(alice, 'ALICE');
        assert.strictEqual(self.username, 'alice');
        assert.ok(self.pastes.some((p) => p.slug === priv));
        const other = await svc.byUser(bob, 'alice');
        assert.ok(!other.pastes.some((p) => p.slug === priv || p.slug === unl));
        assert.strictEqual(other.total, other.pastes.length);
    });

    await check('views: counted once per visitor (cooldown), never for the owner, never for bots, not with noView', async () => {
        const slug = (await svc.createText(alice, { content: 'views' })).slug;
        assert.strictEqual((await svc.get(alice, slug)).paste.views, 0, 'owner');
        assert.strictEqual((await svc.get(bob, slug)).paste.views, 1);
        assert.strictEqual((await svc.get(bob, slug)).paste.views, 1, 'cooldown');
        assert.strictEqual((await svc.get(anon, slug, { ip: '198.51.100.1' })).paste.views, 2);
        assert.strictEqual((await svc.get(anon, slug, { ip: '198.51.100.2', userAgent: 'Googlebot/2.1' })).paste.views, 2, 'bot');
        assert.strictEqual((await svc.get(anon, slug, { ip: '198.51.100.3', noView: true })).paste.views, 2, 'no_view');
        const p = (await svc.get(anon, slug, { ip: '198.51.100.3' })).paste;
        assert.strictEqual(p.views, 3);
        assert.strictEqual(p.unique_views, 3);
        const visits = db.prepare('SELECT visitor FROM paste_visits WHERE paste_id = ?').all(p.id).map((r) => r.visitor);
        assert.ok(visits.every((v) => !v.includes('198.51.100')), 'addresses are hashed, never stored');
    });

    await check('burn after read: the owner reads freely; the first other read shows it, the second burns it (410)', async () => {
        const slug = (await svc.createText(alice, { content: 'secret', burn_after_read: true })).slug;
        assert.strictEqual((await svc.get(alice, slug)).paste.content, 'secret');
        const first = await svc.get(bob, slug);
        assert.strictEqual(first.paste.content, 'secret');
        assert.strictEqual(first.paste.burn_after_read, true);
        await rejects(svc.get(anon, slug, { ip: '203.0.113.5' }), 410, 'This paste has been burned after reading.');
        await rejects(svc.get(alice, slug), 404);
        const row = db.prepare('SELECT content, deleted_at FROM pastes WHERE slug = ?').get(slug);
        assert.strictEqual(row.content, null, 'content scrubbed');
        assert.ok(row.deleted_at);
        // Raw text: Media's rule — the first read serves it, the next one burns it.
        const raw = (await svc.createText(alice, { content: 'raw secret', burn_after_read: true })).slug;
        assert.strictEqual(svc.raw(bob, raw).content, 'raw secret');
        await rejects(Promise.resolve().then(() => svc.raw(bob, raw)), 410);
    });

    await check('fork: text only, "Fork of …", public, forked_from set; like toggles; copy counts', async () => {
        const f = await svc.fork(bob, pub);
        assert.strictEqual(f.paste.title, 'Fork of Hello');
        assert.strictEqual(f.paste.visibility, 'public');
        assert.strictEqual(f.paste.owner_subject, bob.subject);
        assert.strictEqual(f.paste.forked_from, (await svc.get(anon, pub, { noView: true })).paste.id);
        db.prepare("INSERT INTO pastes (slug, type, title, screenshot_url) VALUES ('shot-only-1', 'screenshot', 'S', 'https://openvibe.media/f/x.png')").run();
        await rejects(svc.fork(bob, 'shot-only-1'), 400, 'Only text pastes can be forked');
        assert.deepStrictEqual(svc.like(bob, pub), { liked: true, likes: 1 });
        assert.deepStrictEqual(svc.like(alice, pub), { liked: true, likes: 2 });
        assert.deepStrictEqual(svc.like(bob, pub), { liked: false, likes: 1 });
        await rejects(Promise.resolve().then(() => svc.like(anon, pub)), 401, 'Authentication required');
        assert.strictEqual((await svc.get(alice, pub, { noView: true })).paste.liked, true);
        assert.strictEqual((await svc.get(bob, pub, { noView: true })).paste.liked, false);
        assert.deepStrictEqual(svc.copy(anon, pub), { copies: 1 });
        assert.deepStrictEqual(svc.copy(anon, pub), { copies: 2 });
    });

    await check('comments: anonymous with a cleaned name, replies one level deep, newest first, delete rules', async () => {
        const a = (await svc.addComment(anon, pub, { message: ' hi ', anon_name: 'Guest <b>!' }, { ip: '1.2.3.4' })).comment;
        assert.strictEqual(a.message, 'hi');
        assert.strictEqual(a.anon_name, 'Guest b');
        assert.strictEqual(a.user_id, null);
        const b = (await svc.addComment(bob, pub, { message: 'first!' })).comment;
        assert.strictEqual(b.user_id, bob.subject);
        assert.strictEqual(b.username, 'bob');
        const r = (await svc.addComment(alice, pub, { message: 'reply', parent_id: b.id })).comment;
        assert.strictEqual(r.parent_id, b.id);
        await rejects(svc.addComment(anon, pub, { message: 'deep', parent_id: r.id }, { ip: '1.2.3.5' }), 400, 'Cannot reply to a reply — reply to the original comment instead');
        await rejects(svc.addComment(anon, pub, { message: '' }), 400, 'Comment cannot be empty');
        await rejects(svc.addComment(anon, pub, { message: 'x'.repeat(2001) }), 400, 'Comment must be under 2000 characters');
        await rejects(svc.addComment(anon, pub, { message: 'bad parent', parent_id: 99999 }), 400, 'Invalid parent comment');
        const list = await svc.comments(anon, pub);
        assert.strictEqual(list.total, 3);
        assert.strictEqual(list.comments[0].id, b.id, 'newest top-level first');
        assert.strictEqual(list.comments[0].reply_count, 1);
        assert.strictEqual(list.comments[0].replies[0].username, 'alice');
        assert.strictEqual(list.comments[0].replies[0].display_name, 'Alice');
        // Delete: author, paste owner or staff; everyone else 403; anonymous 401.
        await rejects(Promise.resolve().then(() => svc.deleteComment(anon, pub, b.id)), 401);
        await rejects(Promise.resolve().then(() => svc.deleteComment({ kind: 'user', subject: ids.newId('user'), staff: false }, pub, b.id)), 403, 'Not authorized to delete this comment');
        assert.deepStrictEqual(svc.deleteComment(bob, pub, b.id), { message: 'Comment deleted' });
        assert.deepStrictEqual(svc.deleteComment(alice, pub, a.id), { message: 'Comment deleted' }, 'paste owner');
        await rejects(Promise.resolve().then(() => svc.deleteComment(alice, pub, 424242)), 404, 'Comment not found');
        assert.strictEqual((await svc.comments(anon, pub)).total, 1, 'deleted comments are hidden (the reply remains)');
    });

    await check('comment limits for people: cooldown, then duplicate', async () => {
        const strict = createPasteService({ db, config: {}, limits: { commentCooldownSeconds: 10 } });
        const carol = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
        await strict.addComment(carol, pub, { message: 'one' });
        await rejects(strict.addComment(carol, pub, { message: 'two' }), 429);
        const loose = createPasteService({ db, config: {}, limits: { commentCooldownSeconds: 0 } });
        await loose.addComment(carol, pub, { message: 'same' });
        await rejects(loose.addComment(carol, pub, { message: 'same' }), 400, 'Duplicate comment');
    });

    await check('paste limits for people: cooldown with seconds to wait, daily cap', async () => {
        const strict = createPasteService({ db, config: {}, limits: { cooldownSeconds: 30, maxPerUserPerDay: 200 } });
        const dave = { kind: 'user', subject: ids.newId('user'), staff: false, origin: 'user' };
        await strict.createText(dave, { content: 'a' });
        const err = await rejects(strict.createText(dave, { content: 'b' }), 429);
        assert.ok(err.body.cooldown > 0 && err.body.cooldown <= 30);
        assert.match(err.body.error, /^Please wait \d+s before creating another paste$/);
        const capped = createPasteService({ db, config: {}, limits: { cooldownSeconds: 0, maxPerUserPerDay: 1 } });
        await rejects(capped.createText(dave, { content: 'c' }), 429, 'Daily paste limit reached (1/day)');
        // Anonymous callers aren't limited here (the per-address limiter in api.js is).
        await strict.createText(anon, { content: 'x' });
        await strict.createText(anon, { content: 'y' });
        assert.deepStrictEqual(Object.keys(capped.config(dave)), ['maxSizeKb', 'screenshotMaxSizeMb', 'cooldownSeconds', 'maxPerUserPerDay', 'todayCount']);
        assert.strictEqual(capped.config(dave).todayCount, 1);
    });

    await check('update: owner or staff; versions appended; pinned staff-only; errors', async () => {
        await rejects(svc.update(anon, pub, { title: 'x' }), 401, 'Authentication required');
        await rejects(svc.update(bob, pub, { title: 'x' }), 403, 'Not authorized for this paste');
        await rejects(svc.update(bob, priv, { title: 'x' }), 404, 'Paste not found');
        await rejects(Promise.resolve().then(() => svc.remove(bob, priv)), 404, 'Paste not found');
        await rejects(svc.update(alice, pub, {}), 400, 'Nothing to update');
        await rejects(svc.update(alice, pub, { content: 'x'.repeat(512 * 1024 + 1) }), 400, 'Too large');
        const u = await svc.update(alice, pub, { content: 'def f():\n  pass', pinned: true });
        assert.strictEqual(u.paste.language, 'python');
        assert.strictEqual(u.paste.pinned, false, 'owners cannot pin');
        assert.strictEqual(u.paste.revision, 2);
        const m = await svc.update(mod, pub, { title: 'Renamed', pinned: true });
        assert.strictEqual(m.paste.pinned, true);
        assert.strictEqual(m.paste.revision, 3);
        const v = svc.versions(alice, pub);
        assert.deepStrictEqual(v.versions.map((x) => x.revision), [1, 2, 3]);
        assert.strictEqual(v.versions[0].content, 'const x = 1;', 'original snapshotted');
        assert.strictEqual(v.versions[1].edited_by, alice.subject);
        assert.strictEqual(v.versions[2].edited_by, mod.subject);
        await svc.update(alice, pub, { visibility: 'unlisted' });
        assert.strictEqual(svc.versions(alice, pub).revision, 3, 'visibility changes are not text revisions');
        await rejects(Promise.resolve().then(() => svc.versions(bob, unl)), 403);
    });

    await check('delete: owner or staff; soft delete keeps the slug reserved; gone from reads and lists', async () => {
        await rejects(Promise.resolve().then(() => svc.remove(bob, unl)), 403);
        assert.deepStrictEqual(svc.remove(alice, unl), { success: true });
        await rejects(svc.get(alice, unl), 404);
        assert.deepStrictEqual(svc.remove(mod, priv), { success: true }, 'staff');
        const row = db.prepare('SELECT slug, content, deleted_at FROM pastes WHERE slug = ?').get(unl);
        assert.ok(row && row.deleted_at && row.content === null);
        assert.ok(!(await svc.list(alice, { username: 'alice', include_unlisted: '1', limit: 200 })).pastes.some((p) => p.slug === unl));
    });

    await check('staff tools: stats, forks, bulk, AI write-back', async () => {
        const stats = svc.stats().stats;
        assert.ok(stats.total > 0 && stats.forks >= 1 && stats.textPastes > 0);
        assert.ok(svc.forks({}).forks.length >= 1);
        const b = svc.bulk({ slugs: [pub, 'no-such-slug'], action: 'unlisted' });
        assert.deepStrictEqual(b, { done: 1, skipped: 1 });
        assert.throws(() => svc.bulk({ slugs: [], action: 'delete' }), /No slugs provided/);
        assert.throws(() => svc.bulk({ slugs: [pub], action: 'nuke' }), /Invalid action/);
        const ai = await svc.setAi(mod, pub, { ai_summary: 's'.repeat(3000), ai_tags: ['a', 'b'] });
        assert.strictEqual(ai.ok, true);
        assert.strictEqual(ai.paste.ai_summary.length, 2000);
        assert.strictEqual(ai.paste.ai_tags, '["a","b"]');
        assert.ok(ai.paste.ai_analyzed_at);
        const del = svc.deleteForks();
        assert.ok(del.deleted >= 1 && del.success === true);
    });

    await check('generateSlug never reuses a slug, even a deleted one', async () => {
        const seen = new Set(db.prepare('SELECT slug FROM pastes').all().map((r) => r.slug));
        for (let i = 0; i < 200; i++) { const s = store.generateSlug(db); assert.ok(!seen.has(s)); }
    });

    db.close();
    done();
})();
