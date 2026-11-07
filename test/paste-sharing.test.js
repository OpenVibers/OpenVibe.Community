'use strict';
/**
 * Sharing on pastes (design 2026-11-06, the pilot): every audience against every read path, the gate,
 * transfers both ways, the one-call agent API, burn-after-reading refused for people, the backfill of
 * the three old visibility values, and the share events carrying ids only.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const sharingModule = require('../server/sharing');
const pastesApiModule = require('../server/pastes/api');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 }, appOpts: { startSharingWorker: false } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 21, username: 'alex', display_name: 'Alex' });
    const maticus = net.addUser({ network_user_id: 22, username: 'maticus', display_name: 'Maticus' });
    const sam = net.addUser({ network_user_id: 23, username: 'sam', display_name: 'Sam' });
    const jwt = (u, role = 'user') => net.sign({ id: u.network_user_id, subject_id: u.subject_id, username: u.username, display_name: u.display_name, role });
    const alexJwt = jwt(alex), maticusJwt = jwt(maticus), samJwt = jwt(sam);
    const bossJwt = net.sign({ id: 1, subject_id: 'usr_' + '01J0000000000000000000000A', username: 'boss', display_name: 'Boss', role: 'admin' });

    const call = (pathname, { method = 'GET', cookie, token, json, headers = {} } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(pathname, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const share = (slug, opts = {}) => call(`/api/v1/paste/${encodeURIComponent(slug)}/share`, { headers: { 'x-requested-with': 'ov-share' }, ...opts });
    const transferAnswer = (slug, verb, transferId, cookie) => call(`/api/v1/paste/${encodeURIComponent(slug)}/share/transfer/${verb}`,
        { method: 'POST', cookie, json: { transfer_id: transferId }, headers: { 'x-requested-with': 'ov-share' } });
    const startTransfer = (slug, cookie, body) => call(`/api/v1/paste/${encodeURIComponent(slug)}/share/transfer`,
        { method: 'POST', cookie, json: body, headers: { 'x-requested-with': 'ov-share' } });
    const make = async (cookie, input = {}) => {
        const r = await call('/api/pastes', { method: 'POST', cookie, json: { content: 'body', ...input } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json();
    };
    const row = async (slug) => await t.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('community', 'paste', slug);

    let privateSlug;   // alex's, nobody else's

    await check('a new paste is registered with its audience in the same transaction; people maps to private in the old column', async () => {
        assert.deepStrictEqual(sharingModule.refOf('abc'), { service: 'community', kind: 'paste', id: 'abc' });
        assert.strictEqual(typeof pastesApiModule.createPastesApi, 'function');
        const pub = await make(alexJwt, { title: 'Public note', content: 'public body' });
        let s = await row(pub.slug);
        assert.strictEqual(s.audience, 'public');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: alex.subject_id });

        const link = await make(alexJwt, { content: 'link body', visibility: 'unlisted' });
        s = await row(link.slug);
        assert.strictEqual(s.audience, 'link');

        const priv = await make(alexJwt, { content: 'private body', visibility: 'private' });
        privateSlug = priv.slug;
        s = await row(priv.slug);
        assert.strictEqual(s.audience, 'private');
        assert.strictEqual((await t.db.prepare('SELECT visibility FROM pastes WHERE slug = ?').get(priv.slug)).visibility, 'private');

        const people = await make(alexJwt, { title: 'For two', content: 'two only', audience: 'people', members: ['@maticus'] });
        s = await row(people.slug);
        assert.strictEqual(s.audience, 'people');
        assert.strictEqual((await t.db.prepare('SELECT visibility FROM pastes WHERE slug = ?').get(people.slug)).visibility, 'private', 'an old reader of the column fails closed');
        const members = await t.db.prepare('SELECT subject, role FROM share_members WHERE resource_id = ?').all(people.slug);
        assert.strictEqual(members.length, 1);
        assert.deepStrictEqual(members[0].subject, { type: 'user', id: maticus.subject_id });
        assert.strictEqual(members[0].role, 'viewer');
    });

    await check('the paste JSON API is never cacheable: public, link, people, the list and a 404 all say private, no-store', async () => {
        const pub = await make(alexJwt, { title: 'Cache public', content: 'c' });
        const link = await make(alexJwt, { content: 'c', visibility: 'unlisted' });
        const people = await make(alexJwt, { content: 'c', audience: 'people', members: ['@maticus'] });
        for (const [slug, opts] of [[pub.slug, {}], [link.slug, {}], [people.slug, { cookie: alexJwt }], [people.slug, { cookie: maticusJwt }],
            [people.slug, { cookie: samJwt }], ['no-such-paste-404', {}], [pub.slug, { cookie: bossJwt }]]) {
            const r = await call(`/api/pastes/${slug}`, opts);
            assert.strictEqual(r.headers.get('cache-control'), 'private, no-store', `${slug} ${JSON.stringify(opts)} answered ${r.status} with ${r.headers.get('cache-control')}`);
        }
        assert.strictEqual((await call('/api/pastes?limit=5')).headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await call('/api/pastes?limit=5', { cookie: alexJwt })).headers.get('cache-control'), 'private, no-store');
        assert.strictEqual((await call('/api/pastes/no-such-1/raw')).headers.get('cache-control'), 'private, no-store', 'a JSON redirect route too');
    });

    await check('the backfill maps all three old visibility values, and an ownerless paste to Community itself', async () => {
        await t.db.exec("DELETE FROM share_deliveries");
        await t.db.exec("DELETE FROM share_members");
        await t.db.exec("DELETE FROM share_transfers");
        await t.db.exec("DELETE FROM share_access_requests");
        await t.db.exec("DELETE FROM shares WHERE service = 'community' AND kind = 'paste'");
        await t.db.prepare("INSERT INTO pastes (slug, owner_subject, type, title, content, visibility) VALUES (?,?,?,?,?,?)")
            .run('backfill-pub-1', alex.subject_id, 'paste', 'b1', 'c', 'public');
        await t.db.prepare("INSERT INTO pastes (slug, owner_subject, type, title, content, visibility) VALUES (?,?,?,?,?,?)")
            .run('backfill-link-1', alex.subject_id, 'paste', 'b2', 'c', 'unlisted');
        await t.db.prepare("INSERT INTO pastes (slug, owner_subject, type, title, content, visibility) VALUES (?,?,?,?,?,?)")
            .run('backfill-priv-1', alex.subject_id, 'paste', 'b3', 'c', 'private');
        await t.db.prepare("INSERT INTO pastes (slug, owner_subject, type, title, content, visibility) VALUES (?,?,?,?,?,?)")
            .run('backfill-anon-1', null, 'paste', 'b4', 'c', 'public');
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0016_sharing_backfill.sql'), 'utf8');
        await t.db.exec(sql);
        const rows = await t.db.prepare("SELECT resource_id, audience, owner_subject FROM shares WHERE resource_id LIKE 'backfill-%' ORDER BY resource_id").all();
        const by = Object.fromEntries(rows.map((r) => [r.resource_id, r]));
        assert.strictEqual(by['backfill-pub-1'].audience, 'public');
        assert.strictEqual(by['backfill-link-1'].audience, 'link');
        assert.strictEqual(by['backfill-priv-1'].audience, 'private');
        assert.deepStrictEqual(by['backfill-priv-1'].owner_subject, { type: 'user', id: alex.subject_id });
        assert.deepStrictEqual(by['backfill-anon-1'].owner_subject, { type: 'service', id: 'community' });
        for (const slug of ['backfill-pub-1', 'backfill-link-1', 'backfill-priv-1', 'backfill-anon-1']) await t.db.prepare('DELETE FROM pastes WHERE slug = ?').run(slug);
    });

    await check('owner and member read every path; a signed-in non-member and a signed-out reader get exactly 404, the gate, and no title/content', async () => {
        const two = await make(alexJwt, { title: 'The LOOI bridge notes', content: 'SECRET-LOOI', audience: 'people', members: ['@maticus'] });
        const slug = two.slug;
        // Owner.
        for (const [who, cookie] of [['owner', alexJwt], ['member', maticusJwt]]) {
            const page = await call(`/p/${slug}`, { cookie });
            assert.strictEqual(page.status, 200, `${who} page: ${page.text.slice(0, 120)}`);
            assert.ok(page.text.includes('The LOOI bridge notes'), `${who} sees the title`);
            assert.ok(page.text.includes('SECRET-LOOI'), `${who} sees the content`);
            assert.strictEqual((await call(`/p/${slug}/raw`, { cookie })).text, 'SECRET-LOOI', `${who} raw`);
            assert.strictEqual((await call(`/api/pastes/${slug}`, { cookie })).status, 200, `${who} api`);
            assert.strictEqual((await call(`/p/${slug}/download`, { cookie })).text, 'SECRET-LOOI', `${who} download`);
        }
        // Non-member signed in: the gate, 404, never the title or the content or the comments.
        const gate = await call(`/p/${slug}`, { cookie: samJwt });
        assert.strictEqual(gate.status, 404);
        assert.ok(gate.text.includes('shared with specific people'), 'OVShare.gate');
        assert.ok(gate.text.includes('ov-share.js') && gate.text.includes('OVShare.gate'), 'the gate component');
        assert.ok(!gate.text.includes('The LOOI bridge notes') && !gate.text.includes('SECRET-LOOI'), 'no title, no content');
        assert.strictEqual((await call(`/p/${slug}/raw`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/api/pastes/${slug}`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/p/${slug}/download`, { cookie: samJwt })).status, 404);
        // Signed out: the gate with Sign in (an /auth/login link), still nothing else.
        const anonGate = await call(`/p/${slug}`);
        assert.strictEqual(anonGate.status, 404);
        assert.ok(anonGate.text.includes('/auth/login?next='), 'sign in');
        assert.ok(!anonGate.text.includes('SECRET-LOOI'));
        // Comments on it are not readable either: the thread cannot even be opened by an outsider.
        const thread = await call('/api/v1/comments/threads/resolve', { method: 'POST', cookie: samJwt, json: { ref: { service: 'community', type: 'paste', id: slug } } });
        assert.strictEqual(thread.status, 404, thread.text);
        // The API body of a 404 is the plain error, not a share shape.
        assert.deepStrictEqual((await call(`/api/pastes/${slug}`, { cookie: samJwt })).json(), { error: 'Paste not found' });
    });

    await check('staff may look (and the look is in the append-only log); people/private pages carry a generic link preview and no JSON-LD', async () => {
        const two = await make(alexJwt, { title: 'Staff peek', content: 'STAFF-SECRET', audience: 'people', members: ['@maticus'] });
        const page = await call(`/p/${two.slug}`, { cookie: bossJwt });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('STAFF-SECRET'));
        const logs = await t.db.prepare("SELECT action FROM share_log WHERE resource_id = ? AND action LIKE 'staff.%'").all(two.slug);
        assert.ok(logs.length >= 1, 'the staff view is logged');
        assert.ok(page.text.includes('property="og:title" content="A paste on OpenVibe Community'), 'generic og:title');
        assert.ok(!page.text.includes('property="og:title" content="Staff peek"'));
        const ld = page.text.match(/<script type="application\/ld\+json">(.*?)<\/script>/);
        assert.ok(!ld || !ld[1].includes('Staff peek'), 'no paste JSON-LD for people');
        assert.ok(!/og:image" content="[^"]*openvibe\.media/.test(page.text), 'no picture in the preview');
    });

    await check('public and link pastes read anonymously; only public ones reach the lists, the feed, llms and search', async () => {
        const pub = await make(alexJwt, { title: 'Listed public paste', content: 'public text' });
        const link = await make(alexJwt, { title: 'Link only paste', content: 'link text', visibility: 'unlisted' });
        const people = await make(alexJwt, { title: 'People only paste', content: 'people text', audience: 'people', members: ['@maticus'] });
        assert.strictEqual((await call(`/p/${pub.slug}`)).status, 200);
        assert.strictEqual((await call(`/p/${link.slug}`)).status, 200, 'the link is the key');
        assert.strictEqual((await call(`/api/pastes/${link.slug}`)).status, 200);
        assert.strictEqual((await call(`/p/${people.slug}`)).status, 404);
        const list = (await call('/api/pastes?limit=200')).json().pastes.map((p) => p.slug);
        assert.ok(list.includes(pub.slug));
        assert.ok(!list.includes(link.slug) && !list.includes(people.slug), 'nothing unlisted or people in a public list');
        const browse = (await call('/pastes?type=all')).text;
        assert.ok(browse.includes('Listed public paste'));
        assert.ok(!browse.includes('Link only paste') && !browse.includes('People only paste'));
        const feed = (await call('/feed.xml')).text;
        assert.ok(feed.includes('Listed public paste'));
        assert.ok(!feed.includes('Link only paste') && !feed.includes('People only paste'));
        const llms = (await call('/llms-full.txt')).text;
        assert.ok(!llms.includes('People only paste'));
        const sitemap = (await call('/sitemap.xml')).text;
        assert.ok(!sitemap.includes(`/p/${pub.slug}`) && !sitemap.includes(`/p/${people.slug}`), 'paste pages are noindex and never in a sitemap');
        // The agent twin is anonymous: a people paste has none.
        assert.strictEqual((await call(`/p/${people.slug}.md`)).status, 404, 'no Markdown twin of a restricted paste');
        assert.strictEqual((await call(`/p/${pub.slug}.md`)).status, 200);
    });

    await check('the owner changes the audience; people drops it from the public list at once and the old column follows', async () => {
        const pub = await make(alexJwt, { title: 'Going private', content: 'x' });
        const put = await share(pub.slug, { method: 'PUT', cookie: alexJwt, json: { audience: 'people', members: [{ name: '@maticus', role: 'viewer' }] } });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual(put.json().audience, 'people');
        assert.strictEqual((await t.db.prepare('SELECT visibility FROM pastes WHERE slug = ?').get(pub.slug)).visibility, 'private');
        assert.strictEqual((await call(`/p/${pub.slug}`)).status, 404);
        assert.strictEqual((await call(`/p/${pub.slug}`, { cookie: maticusJwt })).status, 200);
    });

    await check('transfer: the recipient previews, accepts (old owner loses access), and decline/cancel leave the owner in place', async () => {
        const p = await make(alexJwt, { title: 'Giving it away', content: 'GIFT', visibility: 'private' });
        let s = await startTransfer(p.slug, alexJwt, { to: '@maticus', keep_access: false });
        // POST .../share/transfer answers the GET body (201), with the pending transfer in it.
        assert.strictEqual(s.status, 201, s.text);
        const transferId = s.json().transfer.id;
        assert.strictEqual(s.json().transfer.state, 'pending');
        // The recipient may look before accepting, and sees the offer banner.
        const preview = await call(`/p/${p.slug}`, { cookie: maticusJwt });
        assert.strictEqual(preview.status, 200);
        assert.ok(preview.text.includes('paste-offer') && preview.text.includes(transferId), 'OVShare.offer');
        // Someone else is still out.
        assert.strictEqual((await call(`/p/${p.slug}`, { cookie: samJwt })).status, 404);
        // Accept as the recipient.
        const accepted = await transferAnswer(p.slug, 'accept', transferId, maticusJwt);
        assert.strictEqual(accepted.status, 200, accepted.text);
        assert.strictEqual(accepted.json().state, 'accepted');
        assert.strictEqual((await call(`/api/pastes/${p.slug}`, { cookie: maticusJwt })).json().paste.owner_subject, maticus.subject_id);
        assert.strictEqual((await call(`/p/${p.slug}`, { cookie: alexJwt })).status, 404, 'the old owner loses access');
        assert.strictEqual((await t.db.prepare('SELECT owner_subject FROM pastes WHERE slug = ?').get(p.slug)).owner_subject, maticus.subject_id);

        // Decline: nothing changes.
        const q = await make(alexJwt, { content: 'stay mine', visibility: 'private' });
        let tr = (await startTransfer(q.slug, alexJwt, { to: '@sam' })).json().transfer;
        assert.strictEqual((await transferAnswer(q.slug, 'decline', tr.id, samJwt)).json().state, 'declined');
        assert.strictEqual((await call(`/p/${q.slug}`, { cookie: alexJwt })).status, 200);
        assert.strictEqual((await call(`/p/${q.slug}`, { cookie: samJwt })).status, 404);

        // Cancel by the owner: the recipient's preview ends.
        tr = (await startTransfer(q.slug, alexJwt, { to: '@sam' })).json().transfer;
        assert.strictEqual((await transferAnswer(q.slug, 'cancel', tr.id, alexJwt)).status, 200);
        assert.strictEqual((await call(`/p/${q.slug}`, { cookie: samJwt })).status, 404);

        // Expiry: an offer whose time has past cannot be accepted.
        tr = (await startTransfer(q.slug, alexJwt, { to: '@sam' })).json().transfer;
        await t.db.prepare("UPDATE share_transfers SET expires_at = now() - interval '1 minute' WHERE id = ?").run(tr.id);
        assert.strictEqual((await transferAnswer(q.slug, 'accept', tr.id, samJwt)).status, 409);
        assert.strictEqual((await call(`/p/${q.slug}`, { cookie: alexJwt })).status, 200, 'a lapsed offer changes nothing');
    });

    await check('transfer with keep_access true: the old owner keeps viewing, the paste becomes people so that access is real', async () => {
        const p = await make(alexJwt, { title: 'Keep me', content: 'KEEP', visibility: 'private' });
        const tr = (await startTransfer(p.slug, alexJwt, { to: '@maticus', keep_access: true })).json().transfer;
        assert.strictEqual((await transferAnswer(p.slug, 'accept', tr.id, maticusJwt)).status, 200);
        const s = await row(p.slug);
        assert.strictEqual(s.audience, 'people');
        assert.strictEqual((await call(`/api/pastes/${p.slug}`, { cookie: maticusJwt })).json().paste.owner_subject, maticus.subject_id);
        assert.strictEqual((await call(`/p/${p.slug}`, { cookie: alexJwt })).status, 200, 'the old owner still reads it');
        assert.strictEqual((await call(`/p/${p.slug}`, { cookie: samJwt })).status, 404, 'and nobody else does');
    });

    await check('a transferred screenshot\'s Media object follows the paste: re-hosted private, owned by the new owner', async () => {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.from('TRANSFER-PIXELS'), Buffer.from([0xff, 0xd9])]);
        const fd = new FormData();
        fd.append('title', 'Transfer shot');
        fd.append('visibility', 'private');
        fd.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 't.jpg');
        const made = await t.get('/api/pastes/screenshot', { method: 'POST', cookies: [`ov_token=${alexJwt}`], body: fd });
        assert.strictEqual(made.status, 201, made.text);
        const slug = made.json().slug;
        const before = t.media.uploads[t.media.uploads.length - 1];
        assert.strictEqual(before.visibility, 'private');
        assert.strictEqual(before.owner, alex.subject_id);
        const tr = (await startTransfer(slug, alexJwt, { to: '@maticus', keep_access: false })).json().transfer;
        assert.strictEqual((await transferAnswer(slug, 'accept', tr.id, maticusJwt)).status, 200);
        const after = t.media.uploads[t.media.uploads.length - 1];
        assert.notStrictEqual(after.key, before.key, 'a new object');
        assert.strictEqual(after.visibility, 'private');
        assert.strictEqual(after.owner, maticus.subject_id, 'owned by the new owner');
        const row = await t.db.prepare('SELECT media_ref, metadata FROM pastes WHERE slug = ?').get(slug);
        assert.strictEqual(row.media_ref, after.key);
        assert.strictEqual(t.media.uploads.find((u) => u.key === before.key), undefined, 'the old object is gone');
        assert.ok(t.media.deletes.includes(before.key));
        assert.strictEqual(JSON.parse(row.metadata).previous_media_ref, undefined, 'nothing left to retry');
        assert.strictEqual((await call(`/p/${slug}/screenshot`, { cookie: maticusJwt })).status, 200);
    });

    await check('one API call: audience people + members + transfer_to makes a paste only the two can open and offers it', async () => {
        const r = await call('/api/pastes', {
            method: 'POST', cookie: alexJwt,
            json: { title: 'Only two', content: 'AGENT-SECRET', audience: 'people', members: ['@maticus'], transfer_to: '@maticus', keep_access: false },
        });
        assert.strictEqual(r.status, 201, r.text);
        const out = r.json();
        assert.strictEqual(out.paste.audience, 'people');
        assert.ok(out.transfer && out.transfer.id && out.transfer.state === 'pending');
        assert.strictEqual((await call(`/p/${out.slug}`)).status, 404);
        assert.strictEqual((await call(`/p/${out.slug}`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/p/${out.slug}`, { cookie: maticusJwt })).status, 200);
        assert.strictEqual((await call(`/p/${out.slug}`, { cookie: alexJwt })).status, 200);
        const logs = await t.db.prepare("SELECT action FROM share_log WHERE resource_id = ? ORDER BY sequence").all(out.slug);
        assert.ok(logs.some((l) => l.action === 'member.added'));
        assert.ok(logs.some((l) => l.action === 'transfer.requested'));
    });

    await check('burn after reading cannot be shared with specific people (plain refusal)', async () => {
        const r = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'once', audience: 'people', members: ['@maticus'], burn_after_read: true } });
        assert.strictEqual(r.status, 400);
        assert.match(r.json().error, /Burn-after-reading pastes cannot be shared with specific people/);
        const p = await make(alexJwt, { content: 'once too', burn_after_read: true });
        const put = await share(p.slug, { method: 'PUT', cookie: alexJwt, json: { audience: 'people', members: ['@maticus'] } });
        assert.strictEqual(put.status, 400);
        assert.strictEqual((await row(p.slug)).audience, 'public', 'nothing changed');
    });

    await check('share events carry ids only: no title or content in any queued delivery', async () => {
        const title = 'EVENT-TITLE-MUST-NOT-LEAK';
        const p = await make(alexJwt, { title, content: 'EVENT-BODY-MUST-NOT-LEAK', audience: 'people', members: ['@maticus'] });
        const rows = await t.db.prepare("SELECT body FROM share_deliveries WHERE body->>'channel' IS NULL").all();
        // Every queued body, both events and notifications, is a JSON object; none may name the paste.
        const all = await t.db.prepare('SELECT channel, body FROM share_deliveries').all();
        assert.ok(all.length >= 1);
        for (const d of all) {
            const text = JSON.stringify(d.body);
            assert.ok(!text.includes(title), `${d.channel} must not carry the title`);
            assert.ok(!text.includes('EVENT-BODY-MUST-NOT-LEAK'), `${d.channel} must not carry the content`);
        }
        assert.ok(rows !== undefined);
        assert.ok(!JSON.stringify(await row(p.slug)).includes(title), 'the share row never stores a title');
    });

    await check('the screenshot proxy is the only way to the bytes: members through it, outsiders never, and no Media URL in HTML', async () => {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.from('PIXELS'), Buffer.from([0xff, 0xd9])]);
        const fd = new FormData();
        fd.append('title', 'Shot for two');
        fd.append('audience', 'people');
        fd.append('members', '@maticus');
        fd.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 's.jpg');
        const made = await t.get('/api/pastes/screenshot', { method: 'POST', cookies: [`ov_token=${alexJwt}`], body: fd });
        assert.strictEqual(made.status, 201, made.text);
        const slug = made.json().slug;
        const up = t.media.uploads[t.media.uploads.length - 1];
        assert.strictEqual(up.visibility, 'private');
        const page = await call(`/p/${slug}`, { cookie: maticusJwt });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes(`/p/${slug}/screenshot`));
        assert.ok(!page.text.includes('openvibe.media/o/') && !page.text.includes(up.key), 'never the Media object URL');
        const bytes = await call(`/p/${slug}/screenshot`, { cookie: maticusJwt });
        assert.strictEqual(bytes.status, 200);
        assert.strictEqual(bytes.headers.get('content-type'), 'image/jpeg');
        assert.strictEqual(bytes.headers.get('cache-control'), 'private, no-store', 'a members-only screenshot is never cached');
        assert.ok(bytes.text.includes('PIXELS'));
        assert.strictEqual((await call(`/p/${slug}/screenshot`, { cookie: samJwt })).status, 404);
        assert.strictEqual((await call(`/p/${slug}/screenshot`)).status, 404);
        assert.strictEqual((await call(`/p/${slug}/screenshot`, { cookie: alexJwt })).status, 200, 'the owner too');
    });

    await check('a public screenshot is cached like an asset; a members-only one never is', async () => {
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0xff, 0xda, 0x00, 0x04, 0x00, 0x00]), Buffer.from('PIXELS'), Buffer.from([0xff, 0xd9])]);
        const fd = new FormData();
        fd.append('title', 'Shot for everyone');
        fd.append('audience', 'public');
        fd.append('screenshot', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
        const made = await t.get('/api/pastes/screenshot', { method: 'POST', cookies: [`ov_token=${alexJwt}`], body: fd });
        assert.strictEqual(made.status, 201, made.text);
        const got = await call(`/p/${made.json().slug}/screenshot`);
        assert.strictEqual(got.status, 200);
        assert.strictEqual(got.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'a public screenshot is an immutable asset');
    });

    await check('the move script re-hosts, deletes the old object, and retries a failed delete; --keep-old keeps it', async () => {
        const { createMediaObjects } = require('../server/media/objects');
        const { moveScreenshotsPrivate } = require('../scripts/move-screenshots-private');
        const cfg = require('../server/config');
        const mo = createMediaObjects({ config: cfg });
        const quiet = { log() {}, warn() {} };
        const mkOld = async (slug) => {
            const o = await mo.uploadImage({ buffer: Buffer.from('OLD-SHOT-BYTES'), mime: 'image/png', filename: 'old.png', owner: alex.subject_id, kind: 'screenshot', visibility: 'unlisted' });
            await t.db.prepare("INSERT INTO shares (service, kind, resource_id, owner_subject, audience) VALUES ('community','paste',?,?::jsonb,'public')")
                .run(slug, JSON.stringify({ type: 'user', id: alex.subject_id }));
            await t.db.prepare('INSERT INTO pastes (slug, owner_subject, type, title, content, visibility, screenshot_url, media_ref, metadata) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(slug, alex.subject_id, 'screenshot', 'Old shot', '', 'public', `${t.media.url}/o/${o.id}`, o.id, JSON.stringify({ mime_type: 'image/png', original_name: 'old.png' }));
            return o.id;
        };

        // 1. A move deletes the old object and clears the record.
        const first = await mkOld('old-unlisted-shot-1');
        let out = await moveScreenshotsPrivate({ db: t.db, mediaObjects: mo, limit: 20, apply: true, log: quiet });
        assert.strictEqual(out.moved, 1, JSON.stringify(out));
        assert.strictEqual(out.deleted, 1, JSON.stringify(out));
        assert.strictEqual(t.media.uploads.find((u) => u.key === first), undefined, 'the old object is gone');
        let row = await t.db.prepare('SELECT screenshot_url, media_ref, metadata FROM pastes WHERE slug = ?').get('old-unlisted-shot-1');
        assert.match(row.media_ref, /^med_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.notStrictEqual(row.media_ref, first, 'a new object');
        assert.strictEqual(JSON.parse(row.metadata).media_visibility, 'private');
        assert.strictEqual(JSON.parse(row.metadata).previous_media_ref, undefined);
        assert.strictEqual((await call(`/p/${'old-unlisted-shot-1'}/screenshot`, { cookie: alexJwt })).status, 200);
        assert.strictEqual((await call(`/p/${'old-unlisted-shot-1'}/screenshot`)).status, 200, 'the audience is still public');

        // 2. --keep-old leaves the old object alone (an operator's explicit choice).
        const kept = await mkOld('old-unlisted-shot-2');
        out = await moveScreenshotsPrivate({ db: t.db, mediaObjects: mo, limit: 20, apply: true, keepOld: true, log: quiet });
        assert.ok(out.moved >= 1 && out.deleted === 0, JSON.stringify(out));
        assert.ok(t.media.uploads.find((u) => u.key === kept), 'the old object stays');
        row = await t.db.prepare('SELECT metadata FROM pastes WHERE slug = ?').get('old-unlisted-shot-2');
        assert.strictEqual(JSON.parse(row.metadata).previous_media_ref, undefined, 'nothing queued for deletion');

        // 3. A failed delete is recorded and retried on the next run.
        const stubborn = await mkOld('old-unlisted-shot-3');
        t.media.failNextDelete();
        out = await moveScreenshotsPrivate({ db: t.db, mediaObjects: mo, limit: 20, apply: true, log: quiet });
        assert.ok(out.deleteFailed >= 1, JSON.stringify(out));
        assert.ok(t.media.uploads.find((u) => u.key === stubborn), 'still there after the failure');
        row = await t.db.prepare('SELECT metadata FROM pastes WHERE slug = ?').get('old-unlisted-shot-3');
        assert.strictEqual(JSON.parse(row.metadata).previous_media_ref, stubborn, 'recorded for the retry');
        out = await moveScreenshotsPrivate({ db: t.db, mediaObjects: mo, limit: 20, apply: true, log: quiet });
        assert.ok(out.deleted >= 1, JSON.stringify(out));
        assert.strictEqual(t.media.uploads.find((u) => u.key === stubborn), undefined, 'the retry deleted it');
        row = await t.db.prepare('SELECT metadata FROM pastes WHERE slug = ?').get('old-unlisted-shot-3');
        assert.strictEqual(JSON.parse(row.metadata).previous_media_ref, undefined, 'the record is cleared');
    });

    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
