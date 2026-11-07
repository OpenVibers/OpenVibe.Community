'use strict';
/**
 * The public paste address (URL decisions 2026-11-07): /p/<title-slug>-<public id>. The id is the
 * address, the title slug decoration: the id alone and every old adjective-noun-number slug 301 to the
 * one canonical form, a retitle moves it, and a secret paste keeps its secret slug (its id is not a
 * second key). The page stays noindex and is never in the sitemap or IndexNow.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ pasteLimits: { cooldownSeconds: 0 } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const svc = (cap) => net.signService({ cap });
    const create = (body) => t.get('/api/pastes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${svc(['community.paste.create'])}`, 'x-ov-subject': alex.subject_id },
        body: JSON.stringify(body),
    });
    const update = (slug, body) => t.get(`/api/pastes/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${svc(['community.paste.write'])}`, 'x-ov-subject': alex.subject_id },
        body: JSON.stringify(body),
    });
    const canonicalOf = (r) => r.json().paste.canonical_slug;

    try {
        await check('a public paste is named by its title and an 8-char base58 id; the id alone 301s to it', async () => {
            const r = await create({ title: 'My first paste', content: 'hello' });
            assert.strictEqual(r.status, 201, r.text);
            const p = r.json().paste;
            assert.match(p.canonical_slug, /^my-first-paste-[1-9A-HJ-NP-Za-km-z]{8}$/);
            assert.strictEqual(r.json().url, `/p/${p.canonical_slug}`);
            assert.strictEqual(p.url, `/p/${p.canonical_slug}`);
            assert.strictEqual(p.raw_url, `/p/${p.canonical_slug}/raw`);
            const id = p.canonical_slug.split('-').pop();
            const byId = await t.get(`/p/${id}`);
            assert.deepStrictEqual([byId.status, byId.headers.get('location')], [301, `/p/${p.canonical_slug}`]);
            const old = await t.get(`/p/${p.slug}?from=old`);
            assert.deepStrictEqual([old.status, old.headers.get('location')], [301, `/p/${p.canonical_slug}?from=old`]);
        });

        await check('the page, its Markdown twin and JSON-LD name one canonical; the page stays noindex', async () => {
            const p = (await create({ title: 'Canonical paste', content: 'body' })).json().paste;
            const page = await t.get(`/p/${p.canonical_slug}`);
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes(`<link rel="canonical" href="https://openvibe.community/p/${p.canonical_slug}">`), 'canonical');
            assert.ok(page.text.includes('<meta name="robots" content="noindex">'), 'pastes stay noindex');
            assert.ok(page.text.includes(`"url":"https://openvibe.community/p/${p.canonical_slug}"`), 'JSON-LD URL');
            assert.ok(page.text.includes(`href="/p/${p.canonical_slug}/raw"`), 'Raw points at the canonical address');
            const twin = await t.get(`/p/${p.canonical_slug}.md`);
            assert.strictEqual(twin.status, 200, twin.text);
            assert.match(twin.headers.get('content-type'), /^text\/markdown/);
            assert.ok(twin.text.includes(`canonical: "https://openvibe.community/p/${p.canonical_slug}"`), 'the twin agrees');
        });

        await check('a retitle moves the canonical; every old form 301s to the new one', async () => {
            const p = (await create({ title: 'Old name', content: 'body' })).json().paste;
            const oldCanonical = p.canonical_slug;
            const u = await update(p.slug, { title: 'A better name' });
            assert.strictEqual(u.status, 200, u.text);
            const next = canonicalOf(u);
            assert.match(next, /^a-better-name-[1-9A-HJ-NP-Za-km-z]{8}$/);
            assert.notStrictEqual(next, oldCanonical);
            for (const ref of [oldCanonical, p.slug, oldCanonical.split('-').pop()]) {
                const r = await t.get(`/p/${ref}?q=1`);
                assert.deepStrictEqual([r.status, r.headers.get('location')], [301, `/p/${next}?q=1`], ref);
            }
            assert.ok((await t.get('/p/' + next + '.md')).text.includes(`canonical: "https://openvibe.community/p/${next}"`));
        });

        await check('an untitled paste takes its slug from the first content line, or has none', async () => {
            const p = (await create({ content: 'const answer = 42\nconsole.log(answer)' })).json().paste;
            assert.match(p.canonical_slug, /^const-answer-42-[1-9A-HJ-NP-Za-km-z]{8}$/);
            const bare = (await create({ content: '```\n+++---\n```' })).json().paste;   // no ascii words on the first line
            assert.match(bare.canonical_slug, /^[1-9A-HJ-NP-Za-km-z]{8}$/, 'the id alone when there is no title');
            assert.strictEqual((await t.get(`/p/${bare.canonical_slug}`)).status, 200);
        });

        await check('a secret paste keeps its secret slug; its public id is not a second key', async () => {
            const p = (await create({ title: 'A private note', content: 'secret', visibility: 'unlisted' })).json().paste;
            assert.match(p.slug, /^[a-z]+-[a-z]+-[A-Za-z0-9]{16}$/);
            assert.strictEqual(p.canonical_slug, p.slug, 'the secret part stays the address');
            assert.strictEqual((await t.get(`/p/${p.slug}`)).status, 200);
            assert.strictEqual((await t.get(`/p/${p.canonical_slug.split('-').pop()}`)).status, 404, 'the id alone does not open a secret paste');
        });

        await check('a paste minted before the column gets one on first read, then 301s to it', async () => {
            const p = (await create({ title: 'Legacy paste', content: 'old row' })).json().paste;
            await t.db.prepare('UPDATE pastes SET public_id = NULL WHERE slug = ?').run(p.slug);
            const r = await t.get(`/p/${p.slug}`);
            assert.strictEqual(r.status, 301);
            const canonical = r.headers.get('location').slice('/p/'.length);
            assert.match(canonical, /^legacy-paste-[1-9A-HJ-NP-Za-km-z]{8}$/);
            assert.strictEqual((await t.get(`/p/${canonical}`)).status, 200);
            const row = await t.db.prepare('SELECT public_id FROM pastes WHERE slug = ?').get(p.slug);
            assert.strictEqual(row.public_id, canonical.split('-').pop(), 'stored once, not reminted');
        });

        await check('the sitemap lists no paste pages (noindex content is never advertised)', async () => {
            const map = await t.get('/sitemap.xml');
            assert.strictEqual(map.status, 200);
            assert.ok(!/\/p\//.test(map.text), 'no /p/ row');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
