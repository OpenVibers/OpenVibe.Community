'use strict';
/**
 * Pulse's due-based public sources (server/pulse/sources.js): Today's calendar, Network's open stats and Quest's
 * public badges fill Pulse without any per-feed call, and pulse_source_runs makes each source wait its interval.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const iso = (ms) => new Date(ms).toISOString();
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

(async () => {
    const today = day(Date.now());
    const yesterday = day(Date.now() - 86_400_000);
    const badgeAt = iso(Date.now() - 3_600_000);
    const calls = [];
    let eventOwner = null;
    const sourcesFetch = async (url) => {
        calls.push(String(url));
        const u = String(url);
        if (u.includes('/api/v1/events')) return { ok: true, json: async () => ({ events: [
            { id: 'tev_01JAB2C3D4E5F6G7H8J9K0MNPQ', kind: 'event', title: 'Launch party', description: 'Come along', starts_at: iso(Date.now() + 86_400_000), created_at: iso(Date.now() - 60_000), visibility: 'public', status: 'scheduled', owner_subject: eventOwner, url: null },
            { id: 'tev_cancelled', kind: 'event', title: 'Cancelled', visibility: 'public', status: 'cancelled', owner_subject: null },
            { id: 'tev_private', kind: 'event', title: 'Private', visibility: 'followers', status: 'scheduled', owner_subject: null },
        ] }) };
        if (u.includes('/api/v1/stats')) return { ok: true, json: async () => ({ accounts: { total: 1234, daily: [{ day: today, n: 5 }, { day: yesterday, n: 3 }, { day: '2026-01-01', n: 0 }] } }) };
        if (u.includes('/api/v1/entries')) return { ok: true, json: async () => ({ entries: [{ slug: 'open-source-meme', title: 'Open source meme', summary: 'A public entry', published_at: iso(Date.now() - 120_000) }], next_cursor: null }) };
        if (u.includes('/badges')) return { ok: true, json: async () => ({ badges: [
            { id: 'first-post', name: 'First Post', awarded_at: badgeAt },
            { id: 'old-badge', name: 'Old Badge', awarded_at: iso(Date.now() - 90 * 86_400_000) },
        ] }) };
        return { ok: false, status: 404, json: async () => ({}) };
    };

    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { sourcesFetch, startRelay: false, startSharingWorker: false } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    eventOwner = alex.subject_id;
    const asAlex = { kind: 'user', subject: alex.subject_id, staff: false, origin: 'user' };
    await t.app.locals.pastes.createText(asAlex, { title: 'A paste', content: 'Hello' });

    await check('the due job fills today, the member count and a recent Quest badge, and skips old/cancelled rows', async () => {
        const out = await t.app.locals.pulseSources.runOnce({ force: true });
        const by = Object.fromEntries(out.map((x) => [x.name, x]));
        assert.strictEqual(by['today-events'].items, 1, JSON.stringify(out));
        assert.strictEqual(by['network-members'].items, 2);
        assert.strictEqual(by['quest-badges'].items, 1);
        assert.strictEqual(by['meme-entries'].items, 1);
        const feed = (await t.get('/api/v1/feed?limit=40')).json();
        const ev = feed.items.find((x) => x.kind === 'event');
        assert.strictEqual(ev.title, 'Event: Launch party');
        assert.strictEqual(ev.text, 'Come along');
        assert.strictEqual(ev.actor.name, 'Alex');
        const members = feed.items.filter((x) => x.kind === 'member');
        assert.deepStrictEqual(members.map((x) => x.title).sort(), [`3 people joined on ${yesterday}`, '5 people joined today']);
        assert.ok(members.every((x) => x.actor === null && x.site === 'network'));
        const q = feed.items.find((x) => x.kind === 'quest');
        assert.strictEqual(q.title, 'Finished a quest: First Post');
        assert.strictEqual(q.actor.name, 'Alex');
        const meme = feed.items.find((x) => x.kind === 'meme');
        assert.strictEqual(meme.title, 'Open source meme');
        assert.strictEqual(meme.text, 'A public entry');
        assert.strictEqual(meme.url, 'https://openvibe.meme/m/open-source-meme');
        assert.ok(!feed.items.some((x) => /Cancelled|Private|Old Badge/.test(x.title)), feed.items.map((x) => x.title).join(' | '));
    });

    await check('a source that just ran is not due again; the next time is remembered', async () => {
        const quiet = await t.app.locals.pulseSources.runOnce();
        assert.deepStrictEqual(quiet, []);
        const status = await t.app.locals.pulseSources.status();
        assert.deepStrictEqual(status.sources.sort(), ['meme-entries', 'network-members', 'quest-badges', 'today-events']);
        assert.strictEqual(status.runs.length, 4);
        assert.ok(status.runs.every((r) => r.next_run_at && r.last_run_at && !r.last_error));
    });

    await check('the job never runs a service call per feed request', async () => {
        const before = calls.length;
        await t.get('/api/v1/feed?limit=40');
        await t.get('/api/v1/feed?kind=event&limit=40');
        assert.strictEqual(calls.length, before, 'reading the Feed made no external call');
    });

    await check('a re-record that sends no text keeps the card\'s text; one that sends text replaces it', async () => {
        const store = require('../server/pulse/store');
        const key = { source_service: 'today', source_type: 'event', source_id: 'tev_keep', url: 'https://openvibe.today/e/tev_keep', origin: 'system', occurred_at: '2026-11-09T10:00:00Z' };
        await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep', text: 'Bring snacks' });
        let r = await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep (moved)' });
        assert.strictEqual(r.item.text, 'Bring snacks');
        assert.strictEqual(r.item.title, 'Event: Keep (moved)');
        r = await store.upsertItem(t.app.locals.db, { ...key, title: 'Event: Keep', text: '' });
        assert.strictEqual(r.item.text || '', '');
    });

    await check('times are one spelling, so a day reads in order whatever wrote it (ISO from Events, a space locally)', async () => {
        const store = require('../server/pulse/store');
        const db = t.app.locals.db;
        const base = { source_service: 'today', source_type: 'event', url: 'https://openvibe.today/e/x', origin: 'system' };
        await store.upsertItem(db, { ...base, source_id: 'order_iso', title: 'Event: Morning (ISO)', occurred_at: '2030-01-02T08:00:00.000Z' });
        await store.upsertItem(db, { ...base, source_id: 'order_space', title: 'Event: Evening (space)', occurred_at: '2030-01-02 20:00:00' });
        const rows = await db.prepare("SELECT source_id, occurred_at FROM pulse_items WHERE source_id LIKE 'order_%' ORDER BY occurred_at DESC").all();
        assert.deepStrictEqual(rows.map((r) => r.source_id), ['order_space', 'order_iso'], 'the evening one is newer');
        assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.occurred_at)), rows.map((r) => r.occurred_at).join(', '));
        assert.strictEqual(store.pulseTime('2030-01-02T08:00:00+02:00'), '2030-01-02 06:00:00', 'an offset is read, not dropped');
    });

    await done(t);
})();
