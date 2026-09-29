'use strict';
/**
 * IndexNow (openvibe-shared/indexnow): INDEXNOW_KEY unset → the feature is off (no key route, nothing
 * sent). With a key, the key file is served at /<key>.txt as text/plain and publishing an indexable
 * page pings the engines with the page's path and the sitemap. Drafts (unlisted/private), NSFW and
 * burn-after-read pages are never in the sitemap, so they never ping.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const KEY = 'k'.repeat(32);
const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
    delete process.env.INDEXNOW_KEY;
    const off = await boot({ authority: 'community', env: { INDEXNOW_KEY: '' }, pasteLimits: { cooldownSeconds: 0 } });
    await check('without a key IndexNow is off: no key route and nothing sent', async () => {
        assert.strictEqual(off.app.locals.indexnow.enabled, false);
        const res = await off.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 404, res.text);
    });
    await off.close();

    const on = await boot({ authority: 'community', env: { INDEXNOW_KEY: KEY } });
    await check('with a key the key file answers text/plain with the key', async () => {
        assert.strictEqual(on.app.locals.indexnow.enabled, true);
        const res = await on.get(`/${KEY}.txt`);
        assert.strictEqual(res.status, 200, res.text);
        assert.match(res.headers.get('content-type'), /text\/plain/);
        assert.strictEqual(res.text, KEY);
    });
    await on.close();

    // A spy in place of the module's HTTP send: records every pingSoon batch.
    const pings = [];
    const spy = {
        enabled: true,
        keyFile: (_req, _res, next) => next(),
        pingSoon: (urls) => { const a = Array.isArray(urls) ? urls : [urls]; pings.push(...a); return a.length; },
        ping: async () => ({ sent: 0, status: 0 }),
        flush: async () => ({ sent: 0, status: 0 }),
    };
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, env: { INDEXNOW_KEY: '' }, appOpts: { indexnow: spy } });

    await check('a draft (unlisted) never pings', async () => {
        const r = await t.get('/api/pastes', json({ content: 'a draft', visibility: 'unlisted' }));
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(pings, []);
    });

    await check('a publish pings the paste path and the sitemap', async () => {
        const r = await t.get('/api/pastes', json({ content: 'a published paste' }));
        assert.strictEqual(r.status, 201, r.text);
        const slug = r.json().slug;
        assert.ok(pings.includes(`https://openvibe.community/p/${slug}`), JSON.stringify(pings));
        assert.ok(pings.includes('https://openvibe.community/sitemap.xml'), JSON.stringify(pings));
    });

    await check('an NSFW paste never pings', async () => {
        pings.length = 0;
        const r = await t.get('/api/pastes', json({ content: 'nsfw', is_nsfw: true }));
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(pings, []);
    });

    // A signed-in owner (through a service token acting as them) unpublishes their own public paste.
    const alex = t.network.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const svc = (cap) => t.network.signService({ cap });

    await check('unpublishing a public paste pings it again', async () => {
        pings.length = 0;
        const created = await t.get('/api/pastes', { ...json({ content: 'mine' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${svc(['community.paste.create'])}`, 'x-ov-subject': alex.subject_id } });
        assert.strictEqual(created.status, 201, created.text);
        const slug = created.json().slug;
        pings.length = 0;
        const updated = await t.get(`/api/pastes/${slug}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${svc(['community.paste.write'])}`, 'x-ov-subject': alex.subject_id }, body: JSON.stringify({ visibility: 'unlisted' }) });
        assert.strictEqual(updated.status, 200, updated.text);
        assert.ok(pings.includes(`https://openvibe.community/p/${slug}`), JSON.stringify(pings));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
