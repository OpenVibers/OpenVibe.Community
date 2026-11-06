'use strict';
/**
 * Locked pastes (Locker design 2026-11-06, "The pilot, spelled out: locked pastes"): Community stores only the
 * envelope, never the plaintext or a content key; the page opens it in the browser; raw and download are the bytes;
 * removing a member re-seals it; and a locked paste is never public — no list, feed, sitemap, llms, search or JSON-LD.
 *
 * The envelopes and slots are real (openvibe-sdk/locker, P-256), so the people-lock paths are the browser's.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const locker = require('openvibe-sdk/locker');
const searchDocsModule = require('../server/search/documents');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 }, appOpts: { startSharingWorker: false } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 31, username: 'alex', display_name: 'Alex' });
    const maticus = net.addUser({ network_user_id: 32, username: 'maticus', display_name: 'Maticus' });
    const quinn = net.addUser({ network_user_id: 33, username: 'quinn', display_name: 'Quinn' });
    const jwt = (u) => net.sign({ id: u.network_user_id, subject_id: u.subject_id, username: u.username, display_name: u.display_name, role: 'user' });
    const alexJwt = jwt(alex), maticusJwt = jwt(maticus), quinnJwt = jwt(quinn);
    const SUBJ = {
        alex: { type: 'user', id: alex.subject_id },
        maticus: { type: 'user', id: maticus.subject_id },
        quinn: { type: 'user', id: quinn.subject_id },
    };
    const people = {
        alex: await locker.generatePersonKeys(),
        maticus: await locker.generatePersonKeys(),
        quinn: await locker.generatePersonKeys(),
    };
    const pubs = {};
    for (const [name, person] of Object.entries(people)) {
        pubs[name] = await locker.exportPersonKeys(person);
        net.setKeys(SUBJ[name].id, { subject: SUBJ[name], ecdh_public: pubs[name].ecdh, signing_public: pubs[name].signing, fingerprint: pubs[name].fingerprint });
    }

    const call = (pathname, { method = 'GET', cookie, json, headers = {} } = {}) => {
        const h = { ...headers };
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(pathname, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const share = (slug, opts = {}) => call(`/api/v1/paste/${encodeURIComponent(slug)}/share`, { headers: { 'x-requested-with': 'ov-share' }, ...opts });
    const DOC = { v: 1, type: 'paste', title: 'Bridge notes', content: 'the secret words', language: 'text' };
    const plain = JSON.stringify(DOC);
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    const peopleSealed = async (names) => await locker.seal(plain, { lock: 'people', keys: names.map((n) => ({ subject: SUBJ[n], publicKey: pubs[n].ecdh })) });
    const row = async (slug) => await t.db.prepare('SELECT * FROM pastes WHERE slug = ?').get(slug);
    const shareRow = async (slug) => await t.db.prepare('SELECT * FROM shares WHERE service = ? AND kind = ? AND resource_id = ?').get('community', 'paste', slug);
    const slotOf = (sealed, name) => sealed.header.slots.people.find((s) => s.subject.id === SUBJ[name].id);

    let peopleSlug;   // alex's, for alex and maticus

    await check('a people-locked paste stores only the envelope; no response carries the text', async () => {
        const sealed = await peopleSealed(['alex', 'maticus']);
        const r = await call('/api/pastes', {
            method: 'POST', cookie: alexJwt,
            json: {
                locked: true, envelope: b64(sealed.bytes), audience: 'people', title: DOC.title,
                members: [
                    { name: 'maticus', role: 'viewer', key_slot: slotOf(sealed, 'maticus') },
                ],
            },
        });
        assert.strictEqual(r.status, 201, r.text);
        peopleSlug = r.json().slug;

        const stored = await row(peopleSlug);
        assert.strictEqual(stored.locked, true);
        assert.strictEqual(stored.lock_kind, 'people');
        assert.strictEqual(stored.title, 'A locked paste', 'the title is inside the envelope unless the owner shows it');
        assert.strictEqual(stored.title_shown, false);
        assert.strictEqual(stored.content, null, 'no plaintext column');
        assert.strictEqual(stored.envelope, b64(sealed.bytes), 'the envelope is stored as it came');
        assert.ok(!JSON.stringify(stored).includes('the secret words'), 'nothing of the plaintext is in the row');
        assert.strictEqual((await shareRow(peopleSlug)).lock, 'people', 'the share knows how it is sealed');

        const asOwner = (await call(`/api/pastes/${peopleSlug}`, { cookie: alexJwt })).json().paste;
        assert.strictEqual(asOwner.content, null);
        assert.strictEqual(asOwner.title, null, 'the hidden title is not in the API either');
        assert.strictEqual(asOwner.locked, true);
        assert.strictEqual(asOwner.lock, 'people');
        assert.strictEqual(asOwner.envelope_url, `/p/${peopleSlug}/raw`);

        const asMember = (await call(`/api/pastes/${peopleSlug}`, { cookie: maticusJwt })).json().paste;
        assert.strictEqual(asMember.content, null);
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}`, { cookie: quinnJwt })).status, 404, 'not on the list: 404');
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}`)).status, 404, 'signed out: 404');

        const page = await call(`/p/${peopleSlug}`, { cookie: maticusJwt });
        assert.strictEqual(page.status, 200);
        assert.ok(!page.text.includes('the secret words'), 'the page never has the text');
        assert.ok(!page.text.includes(DOC.title), 'nor the title, when it is hidden');
        assert.match(page.text, /paste-locked/, 'the page has the locker card');
        assert.match(page.text, /\/shared\/ov-locker\.js/);
        assert.match(page.text, new RegExp(`/p/${peopleSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/raw`), 'the card is given the envelope address');
        // The meta line describes the paste, not its contents: no "Plain text" and no line count, which would both
        // describe what is inside the envelope. The actions are Share (and Delete); the file is one quiet line.
        assert.ok(!/\b0 lines\b/.test(page.text), 'no line count on a locked paste');
        assert.ok(!/>Plain text<\/a>/.test(page.text), 'no language badge on a locked paste');
        assert.match(page.text, /specific people/, 'the audience chip is there');
        assert.doesNotMatch(page.text, /Raw envelope/, 'the envelope is not a primary action');
        assert.match(page.text, /Download the locked file \(\.ovlk\)[^<]*<\/a> — it opens only with its key/);

        // The key directory was asked as the owner (Network refuses a service token here), never with Community's.
        assert.ok(net.keyCalls.length > 0, 'the owner GET asked for the members’ keys');
        assert.ok(net.keyCalls.every((c) => /^Bearer /.test(c.authorization)), 'the lookups carried a person token');
    });

    await check('a locked paste refuses plaintext, a bad envelope, a public audience and a screenshot', async () => {
        const sealed = await locker.seal(plain, { lock: 'link' });
        const base = { locked: true, envelope: b64(sealed.bytes) };
        assert.strictEqual((await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { ...base, content: 'plain' } })).status, 400, 'plaintext and an envelope together');
        assert.strictEqual((await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { locked: true, envelope: 'not-an-envelope' } })).status, 400);
        assert.strictEqual((await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { ...base, audience: 'public' } })).status, 400, 'never public');
        assert.strictEqual((await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { ...base, burn_after_read: true } })).status, 400, 'no burn');
        assert.strictEqual((await call('/api/pastes', { method: 'POST', json: base })).status, 401, 'locking needs an account');
    });

    await check('a locked paste is never in lists, feeds, the sitemap, llms, search or JSON-LD', async () => {
        const sealed = await locker.seal(plain, { lock: 'link' });
        const made = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { locked: true, envelope: b64(sealed.bytes), audience: 'link', show_title: true, title: 'Shown title' } });
        assert.strictEqual(made.status, 201, made.text);
        const slug = made.json().slug;
        const stored = await row(slug);
        assert.strictEqual(stored.visibility, 'unlisted', 'a link lock is unlisted, never public');
        assert.strictEqual(stored.title, 'Shown title', 'the owner chose to show this one');

        for (const [where, path] of [['the list', '/api/pastes?limit=200'], ['the feed', '/feed.xml'], ['the sitemap', '/sitemap.xml'], ['llms', '/llms-full.txt']]) {
            const out = await call(path);
            assert.ok(!out.text.includes(slug), `${where} does not carry the locked paste`);
        }
        const docs = searchDocsModule.createSearchDocuments({ db: t.db });
        assert.deepStrictEqual(docs.pasteDocument(stored), { deleted: true }, 'Search never holds it');
        const page = await call(`/p/${slug}`);
        assert.ok(!page.text.includes('the secret words'));
        assert.ok(!page.text.includes('"@type":"Article"') && !page.text.includes('"@type": "Article"'), 'no Article JSON-LD for a locked paste');
        assert.match(page.text, /Shown title/, 'a shown title is on the page');
    });

    await check('raw and download are the envelope bytes, named .ovlk', async () => {
        const sealed = await locker.seal(plain, { lock: 'password', password: 'correct horse battery staple' });
        const made = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { locked: true, envelope: b64(sealed.bytes), audience: 'link' } });
        const slug = made.json().slug;
        const raw = await call(`/p/${slug}/raw`, { cookie: alexJwt });
        assert.strictEqual(raw.status, 200);
        assert.match(raw.headers.get('content-type'), /application\/octet-stream/);
        assert.match(raw.headers.get('content-disposition'), new RegExp(`${slug}\\.ovlk`));
        assert.strictEqual(Number(raw.headers.get('content-length')), sealed.bytes.length, 'the bytes served are exactly the envelope');
        assert.ok(raw.text.startsWith('OVLK'), 'a Locker envelope, not text');
        const dl = await call(`/p/${slug}/download`, { cookie: alexJwt });
        assert.strictEqual(dl.status, 200);
        assert.match(dl.headers.get('content-disposition'), /^attachment; filename="/);
        assert.strictEqual(Number(dl.headers.get('content-length')), sealed.bytes.length);
        assert.strictEqual((await call(`/p/${slug}/raw`, { cookie: quinnJwt })).status, 200, 'a link lock fetches for anyone');
    });

    await check('adding someone wraps for them; removing someone re-seals and their key opens nothing', async () => {
        const current = await row(peopleSlug);
        const bytes = Buffer.from(current.envelope, 'base64');
        // Add quinn: the content key is wrapped for their key; quinn's slot comes from the new envelope.
        const added = await locker.rewrap(bytes, {
            add: [{ subject: SUBJ.quinn, publicKey: pubs.quinn.ecdh }],
            credentials: { privateKey: people.alex.ecdh.privateKey, subject: SUBJ.alex },
        });
        const stored = await t.db.prepare('SELECT key_slot FROM share_members WHERE service = ? AND kind = ? AND resource_id = ? AND subject = ?::jsonb')
            .get('community', 'paste', peopleSlug, JSON.stringify(SUBJ.maticus));
        const matSlot = stored.key_slot;
        let r = await share(peopleSlug, {
            method: 'PUT', cookie: alexJwt,
            json: { audience: 'people', members: [
                { subject: SUBJ.maticus, role: 'viewer', key_slot: matSlot },
                { subject: SUBJ.quinn, role: 'viewer', key_slot: slotOf(added, 'quinn') },
            ], envelope: b64(added.bytes) },
        });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([...new Uint8Array(await locker.open(added.bytes, { privateKey: people.quinn.ecdh.privateKey, subject: SUBJ.quinn }))], [...Buffer.from(plain)], 'quinn opens it');

        // Remove maticus: a fresh key for those who stay, stored before the member goes.
        const removed = await locker.rewrap(added.bytes, {
            remove: [SUBJ.maticus],
            keys: [{ subject: SUBJ.alex, publicKey: pubs.alex.ecdh }, { subject: SUBJ.quinn, publicKey: pubs.quinn.ecdh }],
            credentials: { privateKey: people.alex.ecdh.privateKey, subject: SUBJ.alex },
        });
        r = await share(peopleSlug, {
            method: 'PUT', cookie: alexJwt,
            json: { audience: 'people', members: [
                { subject: SUBJ.quinn, role: 'viewer', key_slot: slotOf(removed, 'quinn') },
            ], envelope: b64(removed.bytes) },
        });
        assert.strictEqual(r.status, 200, r.text);
        const after = await row(peopleSlug);
        assert.strictEqual(after.envelope, b64(removed.bytes), 'the re-sealed envelope replaced the stored one');
        assert.ok(!locker.inspect(removed.bytes).recipients.includes(await locker.jwkThumbprint(pubs.maticus.ecdh)), 'maticus’s slot is gone from the envelope');
        await assert.rejects(async () => await locker.open(removed.bytes, { privateKey: people.maticus.ecdh.privateKey, subject: SUBJ.maticus }), 'maticus opens nothing');
        assert.deepStrictEqual([...new Uint8Array(await locker.open(removed.bytes, { privateKey: people.quinn.ecdh.privateKey, subject: SUBJ.quinn }))], [...Buffer.from(plain)], 'quinn still opens it');
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}`, { cookie: maticusJwt })).status, 404, 'maticus is off the list');

        // The owner's sheet now sees quinn's fingerprint (asked as alex) and no warning.
        const view = (await share(peopleSlug, { cookie: alexJwt })).json();
        assert.strictEqual(view.lock, 'people');
        const members = view.members.filter((m) => m.subject && m.role === 'viewer');
        assert.strictEqual(members.length, 1);
        assert.strictEqual(members[0].key_fingerprint, pubs.quinn.fingerprint);
        assert.strictEqual(members[0].fingerprint_changed, false);
        assert.strictEqual(view.envelope_url, `https://openvibe.community/p/${peopleSlug}/raw`);
    });

    await check('a locked paste cannot be edited, forked, or have its body read', async () => {
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}`, { method: 'PUT', cookie: alexJwt, json: { content: 'rewrite' } })).status, 400);
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}`, { method: 'PUT', cookie: alexJwt, json: { title: 'new title' } })).status, 400);
        assert.strictEqual((await call(`/api/pastes/${peopleSlug}/fork`, { method: 'POST', cookie: alexJwt, json: {} })).status, 400);
        const versions = await call(`/api/pastes/${peopleSlug}/versions`, { cookie: alexJwt });
        assert.strictEqual(versions.status, 200);
        assert.strictEqual(versions.json().versions[0].content, null, 'no content in the history either');
    });

    await check('comments are allowed and are not locked', async () => {
        const r = await call(`/api/pastes/${peopleSlug}/comments`, { method: 'POST', cookie: quinnJwt, json: { message: 'read it, thanks' } });
        assert.strictEqual(r.status, 201, r.text);
        const page = await call(`/p/${peopleSlug}`, { cookie: quinnJwt });
        assert.ok(page.text.includes('read it, thanks'));
        assert.match(page.text, /Comments are not locked/);
    });

    await t.close();
    done();
})();
