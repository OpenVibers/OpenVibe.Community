'use strict';
// The menu's network card for OpenVibe.Community (frame.menu-card@1): GET /.well-known/openvibe-menu.json
// serves "Hot in the forum" — the threads with the most live replies this week — and falls back to "New in the
// forum", the newest public threads, when nothing is hot. Each links to its /forum page. The array validates
// against frame.menu-cards@1, carries only public threads, never 18+ ones, is CORS * and cached for five minutes.
// The SQL is exercised on a real (PGlite) database too: old, deleted, gated, members-only and 18+ rows never show.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCard, cardFrom, threadPath, CARD_TTL_S } = require('../server/menu-card');
const { testDb } = require('./helpers/db');
const { hotThisWeek, recentThreads } = require('../server/forum/store');

const NOW = Date.parse('2026-11-07T12:00:00Z');
const row = (over = {}) => ({
    title: 'A busy thread', slug: 'a-busy-thread', space_slug: 'general', replies: 12,
    last_at: '2026-11-07T10:00:00.000Z', ...over,
});
const fresh = (over = {}) => ({
    title: 'A new thread', slug: 'a-new-thread', space_slug: 'general', replies: 0,
    created_at: '2026-11-07T10:00:00.000Z', author: { display_name: 'Ada' },
    content_labels: { labels: [], suggested: [] }, ...over,
});

// ── Hot card: shape, words and contract ─────────────────────────────────
const card = cardFrom([row(), row({ title: '<b>Rye</b>\nbread', slug: 'rye-bread', space_slug: 'cooking', replies: 1 })], NOW);
const checked = contracts.validate('frame.menu-cards@1', [card]);
assert.ok(checked.valid, JSON.stringify(checked.errors));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'hot-threads');
assert.strictEqual(card.site, 'community');
assert.strictEqual(card.title, 'Hot in the forum');
assert.strictEqual(card.kind, 'rows');
assert.strictEqual(card.ttl_s, CARD_TTL_S);
assert.deepStrictEqual(card.items, [
    { title: 'A busy thread', meta: 'general · 12 replies · 2h ago', url: 'https://openvibe.community/forum/general/a-busy-thread' },
    { title: 'Rye bread', meta: 'cooking · 1 reply · 2h ago', url: 'https://openvibe.community/forum/cooking/rye-bread' },
]);
assert.deepStrictEqual(card.more, { label: 'Visit the forum', url: 'https://openvibe.community/forum' });
assert.ok(card.title.length <= 60);
for (const it of card.items) assert.ok(it.title.length <= 80 && (!it.meta || it.meta.length <= 120) && it.url.startsWith('https://openvibe.community/forum/'));

// ── The fallback: newest public threads, with the author and time ───────
const newest = cardFrom([
    fresh(),
    fresh({ title: 'No name given', slug: 'no-name', space_slug: 'help', author: null }),
    fresh({ title: 'An adult thread', slug: 'adult', content_labels: { labels: ['18+'], suggested: [] } }),
], NOW, { newest: true });
assert.strictEqual(newest.title, 'New in the forum');
assert.deepStrictEqual(newest.items, [
    { title: 'A new thread', meta: 'Ada · 2h ago', url: 'https://openvibe.community/forum/general/a-new-thread' },
    { title: 'No name given', meta: 'help · 2h ago', url: 'https://openvibe.community/forum/help/no-name' },
]);
assert.ok(contracts.validate('frame.menu-cards@1', [newest]).valid);

// Rows with no address, no title, no replies (hot only), private/deleted or 18+ never enter the card, and at most
// five threads are sent.
assert.deepStrictEqual(cardFrom([row({ replies: 0 })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ space_slug: null })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ title: '  ' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ deleted_at: '2026-11-07T11:00:00Z' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ members_only_owner: 'usr_vip' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ visibility: 'members' })], NOW).items, []);
assert.deepStrictEqual(cardFrom([row({ content_labels: { labels: ['18+'], suggested: [] } })], NOW).items, []);
assert.deepStrictEqual(cardFrom([fresh({ deleted_at: '2026-11-07T11:00:00Z' })], NOW, { newest: true }).items, []);
assert.deepStrictEqual(cardFrom(null, NOW).items, []);
const many = Array.from({ length: 9 }, (_, i) => row({ slug: `t${i}`, title: `Thread ${i}` }));
assert.strictEqual(cardFrom(many, NOW).items.length, 5);
assert.strictEqual(threadPath('a b', 'c/d'), '/forum/a%20b/c%2Fd');

// ── The five-minute cache, the fallback switch and the route's headers ──
(async () => {
    let t = NOW;
    let loads = 0;
    let newestLoads = 0;
    const menu = createMenuCard({
        load: async () => { loads++; return [row()]; },
        loadNewest: async () => { newestLoads++; return [fresh()]; },
        now: () => t,
    });
    const first = await menu.card();
    assert.strictEqual(loads, 1);
    assert.strictEqual(newestLoads, 0, 'the newest list is not read while something is hot');
    assert.strictEqual(await menu.card(), first);
    assert.strictEqual(loads, 1, 'a second request inside the ttl is served from the cache');
    t += CARD_TTL_S * 1000 + 1;
    await menu.card();
    assert.strictEqual(loads, 2, 'after the ttl the card is rebuilt');

    // Nothing hot: the card is the newest public threads, titled "New in the forum".
    let hot = [];
    const quiet = createMenuCard({ load: async () => hot, loadNewest: async () => [fresh()], now: () => t });
    const fallback = await quiet.card();
    assert.strictEqual(fallback.title, 'New in the forum');
    assert.strictEqual(fallback.items[0].title, 'A new thread');
    assert.strictEqual(fallback.items[0].meta, 'Ada · 2h ago');
    // An empty site stays empty (Network skips the card), still with the fallback's honest title.
    const gone = createMenuCard({ load: async () => [], loadNewest: async () => [], now: () => t });
    const emptySite = await gone.card();
    assert.deepStrictEqual(emptySite.items, []);
    assert.strictEqual(emptySite.title, 'New in the forum');
    assert.ok(contracts.validate('frame.menu-cards@1', [emptySite]).valid);

    const headers = {};
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        json(v) { body = v; return this; },
    };
    await menu.handler({}, res);
    assert.strictEqual(headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
    assert.strictEqual(headers['Cache-Control'], 'public, max-age=60');
    assert.ok(Array.isArray(body) && body.length === 1, 'the file is an array of cards');
    assert.ok(contracts.validate('frame.menu-cards@1', body).valid);

    // A failing database keeps the last good card rather than publishing an empty list.
    let fail = false;
    const flaky = createMenuCard({ load: async () => { if (fail) throw new Error('db down'); return [row()]; }, now: () => t });
    const good = await flaky.card();
    fail = true;
    t += CARD_TTL_S * 1000 + 1;
    assert.strictEqual(await flaky.card(), good);

    // ── The queries: public, non-gated, non-deleted threads only ──
    const db = await testDb();
    try {
        await db.prepare(`INSERT INTO spaces (id, slug, name, visibility) OVERRIDING SYSTEM VALUE VALUES
            (9001, 'menu-general', 'General', 'public'), (9002, 'menu-insiders', 'Insiders', 'members'),
            (9003, 'menu-mod', 'Mods', 'staff'), (9004, 'menu-vip', 'VIP', 'public')`).run();
        await db.prepare("UPDATE spaces SET members_only_owner = 'usr_vip' WHERE id = 9004").run();
        await db.prepare(`INSERT INTO threads (id, space_id, slug, title, members_only_owner) OVERRIDING SYSTEM VALUE VALUES
            (9001, 9001, 'busy', 'Busy thread', NULL), (9002, 9001, 'warm', 'Warm thread', NULL),
            (9003, 9002, 'members', 'Members thread', NULL), (9004, 9004, 'vip-space', 'VIP space thread', NULL),
            (9005, 9001, 'gated', 'Gated thread', 'usr_vip'), (9006, 9001, 'deleted', 'Deleted thread', NULL)`).run();
        await db.prepare("UPDATE threads SET deleted_at = '2026-11-07 11:00:00' WHERE id = 9006").run();
        await db.prepare(`INSERT INTO posts (id, thread_id, body_markdown, is_opening, created_at) OVERRIDING SYSTEM VALUE VALUES
            (9001, 9001, 'opening', 1, '2026-11-06 10:00:00'), (9002, 9001, 'one', 0, '2026-11-06 10:05:00'), (9003, 9001, 'two', 0, '2026-11-06 10:06:00'),
            (9004, 9002, 'opening', 1, '2026-11-06 10:00:00'), (9005, 9002, 'one', 0, '2026-11-06 10:05:00'),
            (9006, 9003, 'one', 0, '2026-11-06 10:05:00'), (9007, 9004, 'one', 0, '2026-11-06 10:05:00'), (9008, 9005, 'one', 0, '2026-11-06 10:05:00'),
            (9009, 9001, 'old', 0, '2026-10-01 10:00:00'), (9010, 9001, 'deleted', 0, '2026-11-06 10:07:00')`).run();
        await db.prepare("UPDATE posts SET deleted_at = '2026-11-06 11:00:00' WHERE id = 9010").run();
        // A thread can be marked 18+ after it was opened; the menu may not carry it even when it is busy.
        await db.prepare(`UPDATE threads SET content_labels = '{"labels":["18+"],"suggested":[]}'::jsonb WHERE id = 9001`).run();
        const rows = await hotThisWeek(db, { since: '2026-11-01 00:00:00', limit: 6 });
        assert.deepStrictEqual(rows.map((r) => [r.slug, Number(r.replies)]), [['busy', 2], ['warm', 1]]);
        const served = cardFrom(rows, NOW);
        assert.ok(contracts.validate('frame.menu-cards@1', [served]).valid);
        assert.deepStrictEqual(served.items.map((i) => i.title), ['Warm thread'], 'the 18+ thread stays off the card');
        assert.match(served.items[0].meta, /^menu-general · 1 reply · /);

        const newestRows = await recentThreads(db, { visibilities: ['public'], limit: 12 });
        assert.deepStrictEqual(newestRows.map((r) => r.slug).sort(), ['busy', 'warm'],
            'members-only spaces and threads, and deleted threads, never reach the newest list');
        const newestCard = cardFrom(newestRows, NOW, { newest: true });
        assert.deepStrictEqual(newestCard.items.map((i) => i.title), ['Warm thread'], 'the 18+ thread stays off the fallback too');
    } finally {
        await db.close();
    }

    console.log('menu card: hot/newest fallback, contract, 18+ and public queries, plain text, 5 min cache, CORS and last-good card');
})().catch((err) => { console.error(err); process.exit(1); });
