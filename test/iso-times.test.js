'use strict';
/**
 * Times leave with their zone (openvibe.design rule 148): Community's SQLite-era text timestamps are
 * UTC but a browser reads `YYYY-MM-DD HH:MM:SS` as local time. The JSON edge renders time fields as
 * ISO 8601 with Z; the stored text and every query that compares it stay unchanged.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { isoTime, normalizeTimes } = require('../server/http/iso-times');

assert.strictEqual(isoTime('2026-11-12 05:01:02'), '2026-11-12T05:01:02Z');
assert.strictEqual(isoTime('2026-11-12T05:01:02.123Z'), '2026-11-12T05:01:02.123Z', 'ISO with Z is left alone');
assert.strictEqual(isoTime('2026-11-12T05:01:02+02:00'), '2026-11-12T05:01:02+02:00', 'ISO with an offset is left alone');
assert.strictEqual(isoTime('2026-11-12'), '2026-11-12', 'a date is not a time');
assert.strictEqual(isoTime(null), null);
assert.deepStrictEqual(
    normalizeTimes({ id: 1, created_at: '2026-11-12 05:01:02', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12 05:01:02' }, tags: [{ expires_at: '2026-11-12 05:01:02' }] }),
    { id: 1, created_at: '2026-11-12T05:01:02Z', updated_at: null, when: '2026-11-12 05:01:02', meta: { last_seen: '2026-11-12T05:01:02Z' }, tags: [{ expires_at: '2026-11-12T05:01:02Z' }] },
    'time-named fields are rendered; body text that looks like a time is not',
);

(async () => {
    const t = await boot();
    const db = t.app.locals.db || t.db;
    const owner = require('openvibe-contracts').ids.newId('user');
    await db.prepare(`INSERT INTO pastes (slug, owner_subject, title, content, visibility, created_at, updated_at)
        VALUES ('iso-time', ?, 'When', 'body', 'public', '2026-10-01 10:00:00', '2026-10-02 11:30:00')`).run(owner);
    await db.prepare("INSERT INTO shares (service, kind, resource_id, owner_subject, audience) VALUES ('community', 'paste', 'iso-time', ?::jsonb, 'public')").run(JSON.stringify({ type: 'user', id: owner }));

    await check('a paste\'s times are ISO 8601 with Z in the JSON API', async () => {
        const r = await t.get('/api/pastes/iso-time');
        assert.strictEqual(r.status, 200, r.text);
        const body = r.json().paste;
        assert.strictEqual(body.created_at, '2026-10-01T10:00:00Z');
        assert.strictEqual(body.updated_at, '2026-10-02T11:30:00Z');
        assert.match(body.created_at, /Z$/);
        assert.match(body.updated_at, /Z$/);
    });

    await check('the stored text and the API cursor shape are unchanged', async () => {
        const row = await db.prepare("SELECT created_at, updated_at FROM pastes WHERE slug = 'iso-time'").get();
        assert.deepStrictEqual(row, { created_at: '2026-10-01 10:00:00', updated_at: '2026-10-02 11:30:00' });
        const list = await t.get('/api/v1/pulse?limit=1');
        assert.strictEqual(list.status, 200, list.text);
        const items = list.json().items || [];
        if (items.length) assert.doesNotMatch(String(items[0].occurred_at), /^\d{4}-\d\d-\d\d \d\d:/, 'Pulse times are ISO too');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
