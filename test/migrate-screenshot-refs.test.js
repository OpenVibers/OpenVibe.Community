'use strict';
/**
 * scripts/migrate-screenshot-refs.js (C-24): a dry run changes nothing; --apply needs --backup and takes it
 * first; imported pastes (legacy:live:paste:<Live id>) are matched by slug, v1 uploads by their reference;
 * deleted objects and pastes with no object keep their legacy reference; running it again changes nothing.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { openDb } = require('../server/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-c24-'));
const dbPath = path.join(dir, 'community.db');
const db = openDb(dbPath);
const ins = db.prepare("INSERT INTO pastes (slug, type, title, screenshot_url, media_ref) VALUES (?, 'screenshot', 'Shot', ?, ?)");
ins.run('a1', 'https://openvibe.media/p/a1/screenshot', 'legacy:live:paste:2');
ins.run('a2', 'https://openvibe.media/p/a2/screenshot', 'legacy:live:paste:4');
ins.run('a3', 'https://openvibe.media/p/a3/screenshot', 'legacy:live:paste:9');
ins.run('k1', 'https://openvibe.media/f/k1', 'legacy:community:file:k1');
db.prepare("INSERT INTO pastes (slug, type, title, content) VALUES ('t1', 'paste', 'Text', 'x')").run();
db.close();
const M1 = 'med_01KKDDF5T0R3JNZSTEBW0X4AH5', M2 = 'med_01KKDDZWZ0SG9ZQ3ABAKDDSGWG', M3 = 'med_01KKDMS07GK1BS5KWRXWC6NAV8';
const map = path.join(dir, 'refs.json');
fs.writeFileSync(map, JSON.stringify({ objects: [
    { legacy_ref: 'legacy:live:paste:a1', id: M1, lifecycle_status: 'ready' },
    { legacy_ref: 'legacy:live:paste:a2', id: M2, lifecycle_status: 'deleted' },
    { legacy_ref: 'legacy:community:file:k1', id: M3, lifecycle_status: 'ready' },
] }));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'migrate-screenshot-refs.js');
const run = (...extra) => {
    try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [SCRIPT, '--db', dbPath, '--map', map, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) }; } catch (err) { return { code: err.status, out: null }; }
};
const refs = () => { const d = openDb(dbPath); const r = Object.fromEntries(d.prepare('SELECT slug, media_ref FROM pastes ORDER BY id').all().map((x) => [x.slug, x.media_ref])); d.close(); return r; };

let r = run();
assert.strictEqual(r.code, 0);
assert.deepStrictEqual([r.out.candidates, r.out.would_migrate, r.out.no_object, r.out.not_ready, r.out.migrated], [4, 2, 1, 1, 0]);
assert.strictEqual(refs().a1, 'legacy:live:paste:2', 'a dry run changes nothing');
assert.strictEqual(run('--apply').code, 2, '--apply without --backup is refused');
const backup = path.join(dir, 'before.db');
r = run('--apply', '--backup', backup);
assert.strictEqual(r.code, 0); assert.strictEqual(r.out.migrated, 2);
assert.ok(fs.existsSync(backup) && fs.statSync(backup).size > 0, 'the backup was taken');
assert.deepStrictEqual(refs(), { a1: M1, a2: 'legacy:live:paste:4', a3: 'legacy:live:paste:9', k1: M3, t1: null });
r = run('--apply', '--backup', path.join(dir, 'again.db'));
assert.deepStrictEqual([r.out.candidates, r.out.migrated], [2, 0], 'idempotent');
fs.rmSync(dir, { recursive: true, force: true });
console.log('migrate-screenshot-refs: all checks passed');
