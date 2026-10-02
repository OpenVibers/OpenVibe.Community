'use strict';
/**
 * T10 J6 — Community is the only paste authority. The removed proposal is that nothing reads the
 * old authority switch and nothing proxies /api/pastes any more:
 *   - no source file under server/ mentions the switch, the Live paste client or the proxy;
 *   - the config exposes no authority/host for a Live paste API;
 *   - /api/pastes is the native store API (a real list, a native 404), and the Live mock is never called;
 *   - the legacy_media_id / legacy_user_id columns are gone from the paste tables.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');

const SERVER = path.join(__dirname, '..', 'server');
const REMOVED = [
    new RegExp(['PASTES', '_AUTHORITY'].join('')),
    /OV_LIVE_INTERNAL_URL/,
    /pastesAuthority/,
    /liveInternalUrl/,
    new RegExp(['live', '-client'].join('')),
    /pastes\/proxy/,
    /createPastesProxy/,
    /LiveApiError/,
];

function sourceFiles(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) sourceFiles(p, out);
        else if (p.endsWith('.js')) out.push(p);
    }
    return out;
}

(async () => {
    await check('no server/ source mentions the removed paste-authority switch, Live client or proxy', () => {
        const hits = [];
        for (const file of sourceFiles(SERVER)) {
            const text = fs.readFileSync(file, 'utf8');
            for (const re of REMOVED) if (re.test(text)) hits.push(`${path.relative(path.join(__dirname, '..'), file)}: ${re}`);
        }
        assert.deepStrictEqual(hits, []);
        assert.strictEqual(fs.existsSync(path.join(SERVER, 'pastes', 'api.js')), true, 'the native paste API is there');
    });

    await check('config exposes no paste-authority switch or Live paste host', () => {
        const config = require('../server/config');
        assert.ok(!('pastesAuthority' in config), 'pastesAuthority is gone');
        assert.ok(!('liveInternalUrl' in config), 'liveInternalUrl is gone');
    });

    const t = await boot({ pasteLimits: { cooldownSeconds: 0 } });

    await check('/api/pastes is the native API (a list and a native 404), never a proxy to Live', async () => {
        const list = await t.get('/api/pastes?limit=1');
        assert.strictEqual(list.status, 200);
        const body = list.json();
        assert.ok(Array.isArray(body.pastes), 'the native list shape { pastes, total }');
        assert.strictEqual(typeof body.total, 'number');
        const missing = await t.get('/api/pastes/does-not-exist');
        assert.strictEqual(missing.status, 404);
        assert.ok(missing.json().error, 'a native error body, never a proxied response');
        assert.strictEqual(t.live.calls.length, 0, 'Live is never called');
    });

    await check('the paste tables no longer carry the legacy_media_id / legacy_user_id columns', async () => {
        const cols = await t.db.prepare(`SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND column_name IN ('legacy_media_id', 'legacy_user_id')`).all();
        assert.deepStrictEqual(cols, []);
        const kept = await t.db.prepare(`SELECT 1 AS ok FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'legacy_id_map' AND column_name = 'source_id'`).get();
        assert.ok(kept, 'legacy_id_map (identity resolution) is intact');
    });

    await t.close();
    done();
})();
