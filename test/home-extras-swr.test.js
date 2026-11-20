'use strict';
/**
 * The home's extras (the roadmap, the counts, "Across OpenVibe" from Network's feed) are kept a minute; older than that,
 * the last read is served and a new one is made behind it, one at a time (2026-11-20: on the host, every minute one
 * request took 480-650 ms while the others took 40-75 ms). With a Network feed that takes 300 ms to answer:
 *   - the first request waits on it (nothing to serve yet); the next one inside the minute does not ask again;
 *   - a minute on, the page answers without waiting, with the last read, and one new read starts;
 *   - once that read is in, the next request shows it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    let calls = 0;
    let title = 'The first row';
    const wallOf = (t) => ({ items: [{ id: 'f:network:members:n1', source: { service: 'network', type: 'members', id: 'n1' }, title: t, url: 'https://openvibe.network/', origin: 'system', actor: null, occurred_at: new Date().toISOString() }] });
    const feedFetch = async (url) => {
        const wall = String(url).includes('/wall');
        if (wall) { calls++; await new Promise((r) => setTimeout(r, 300)); }
        const body = wall ? wallOf(title) : { items: [], next_cursor: null };
        return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    };
    const t = await boot({ appOpts: { feedFetch } });
    const realNow = Date.now;
    const timed = async () => { const at = realNow(); const r = await t.get('/'); return { r, ms: realNow() - at }; };
    try {
        await check('the first request waits on the read; the next one inside the minute does not read again', async () => {
            const a = await timed();
            assert.strictEqual(a.r.status, 200);
            assert.ok(a.ms >= 280 && a.r.text.includes('The first row'), `${a.ms} ms`);
            const b = await timed();
            assert.strictEqual(calls, 1, 'kept');
            assert.ok(b.ms < 250, `${b.ms} ms`);
        });
        await check('a minute on: the last read is served at once and one new read starts behind it', async () => {
            title = 'A fresh row';
            Date.now = () => realNow() + 61_000;
            const c = await timed();
            assert.ok(c.ms < 250, `answered without waiting on the 300 ms read (${c.ms} ms)`);
            assert.ok(c.r.text.includes('The first row') && !c.r.text.includes('A fresh row'), 'the last read');
            const d = await timed();
            assert.strictEqual(calls, 2, 'one new read, not one a request');
            assert.ok(d.ms < 250, `${d.ms} ms`);
            await new Promise((r) => setTimeout(r, 400));
            const e = await timed();
            assert.ok(e.r.text.includes('A fresh row'), 'the new read shows once it is in');
            assert.strictEqual(calls, 2);
        });
    } finally { Date.now = realNow; await done(t); }
})().catch((err) => { console.error(err); process.exit(1); });
