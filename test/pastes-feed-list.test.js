'use strict';
/**
 * The paste list as OpenVibe.Live's Content (people's pastes) and Moments (AI pastes) feeds read it:
 * ?origin splits people's work from AI output, ?sort=top ranks by views with a like worth five,
 * ?since= bounds a "top this week" window, and ?pinned_first=0 keeps a pinned paste in sort order so
 * a list merged with others by date or score stays in order. Hidden pastes never appear.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { openDb } = require('../server/db');
const store = require('../server/pastes/store');
const { createPasteService } = require('../server/pastes/service');
const { check, done } = require('./helpers/app');

const db = openDb(':memory:');
const svc = createPasteService({ db, config: { oauth: { clientSecret: 'test' } }, limits: { cooldownSeconds: 0 } });
const alice = ids.newId('user');
const viewer = { kind: 'anonymous', subject: null, staff: false, origin: 'user' };
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().replace('T', ' ').slice(0, 19);

const add = (slug, { origin = 'user', visibility = 'public', views = 0, likes = 0, pinned = 0, age = 1, burn = 0, iso = false } = {}) => {
    const row = store.insertPaste(db, { slug, owner_subject: origin === 'ai' ? null : alice, origin, type: 'paste', title: slug, content: slug, language: 'text', visibility, pinned, burn_after_read: burn });
    const at = iso ? new Date(Date.now() - age * 86400_000).toISOString() : daysAgo(age);
    db.prepare('UPDATE pastes SET views = ?, likes = ?, created_at = ? WHERE id = ?').run(views, likes, at, row.id);
};
add('person-new', { age: 1, views: 4 });
add('person-liked', { age: 2, views: 1, likes: 3 });          // score 16
add('person-pinned-old', { age: 30, views: 2, pinned: 1 });
add('person-private', { age: 1, views: 99, visibility: 'private' });
add('person-unlisted', { age: 1, views: 99, visibility: 'unlisted' });
add('person-burn', { age: 1, views: 99, burn: 1 });
add('person-imported-iso', { age: 3, views: 5, iso: true });
add('ai-moment', { origin: 'ai', age: 1, views: 7 });
add('ai-old', { origin: 'ai', age: 20, views: 50 });

const slugs = async (q) => (await svc.list(viewer, q)).pastes.map((p) => p.slug);

(async () => {
    await check('origin=user and origin=ai split the public list; hidden pastes are in neither', async () => {
        const people = await slugs({ origin: 'user', pinned_first: '0' });
        assert.deepStrictEqual(people, ['person-new', 'person-liked', 'person-imported-iso', 'person-pinned-old']);
        assert.deepStrictEqual(await slugs({ origin: 'ai' }), ['ai-moment', 'ai-old']);
        const out = await svc.list(viewer, { origin: 'ai' });
        assert.strictEqual(out.total, 2);
        assert.ok(out.pastes.every((p) => p.origin === 'ai' && p.owner_subject === null));
    });

    await check('pinned pastes lead by default; pinned_first=0 keeps them in date order', async () => {
        assert.strictEqual((await slugs({ origin: 'user' }))[0], 'person-pinned-old');
        assert.strictEqual((await slugs({ origin: 'user', pinned_first: 'false' })).at(-1), 'person-pinned-old');
    });

    await check('sort=top ranks by views with a like worth five views, newest first on a tie', async () => {
        assert.deepStrictEqual(await slugs({ origin: 'user', sort: 'top', pinned_first: '0' }),
            ['person-liked', 'person-imported-iso', 'person-new', 'person-pinned-old']);
    });

    await check('since bounds the window (ISO and SQL forms; imported ISO timestamps compare by time)', async () => {
        const week = new Date(Date.now() - 7 * 86400_000).toISOString();
        assert.deepStrictEqual(await slugs({ origin: 'user', sort: 'top', since: week, pinned_first: '0' }),
            ['person-liked', 'person-imported-iso', 'person-new']);
        const out = await svc.list(viewer, { origin: 'ai', since: daysAgo(7) });
        assert.deepStrictEqual(out.pastes.map((p) => p.slug), ['ai-moment']);
        assert.strictEqual(out.total, 1, 'the total counts the window');
        assert.strictEqual((await svc.list(viewer, { since: 'yesterday-ish' })).total, 6, 'an unreadable since is ignored');
    });

    await check('paging with offset walks the sorted list without repeats', async () => {
        const all = await slugs({ origin: 'user', sort: 'top', pinned_first: '0', limit: 50 });
        const paged = [];
        for (let offset = 0; offset < all.length; offset += 2) paged.push(...await slugs({ origin: 'user', sort: 'top', pinned_first: '0', limit: 2, offset }));
        assert.deepStrictEqual(paged, all);
    });

    db.close();
    done();
})();
