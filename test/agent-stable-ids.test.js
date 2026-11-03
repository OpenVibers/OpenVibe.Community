'use strict';
// AGT-4: agent.json says what a paste's address is, and the store keeps it to one paste.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { agentManifest } = require('openvibe-shared/agent-layer');

const ids = agentManifest(require('../server/agent-descriptor')).policy.stableIds;
assert.deepStrictEqual(ids.map((x) => [x.kind, x.url]), [['paste', 'https://openvibe.community/p/{slug}']]);
const store = fs.readFileSync(path.join(__dirname, '..', 'server', 'pastes', 'store.js'), 'utf8');
// Generation asks slugTaken, which counts every paste row (deleted ones included) and every retired slug.
assert.match(store, /SELECT 1 FROM pastes WHERE slug = \? UNION ALL SELECT 1 FROM retired_paste_slugs WHERE slug_hash = \?/);
assert.match(store, /const taken = \{ get: \(slug\) => slugTaken\(db, slug\) \};/);
// The only hard delete of a paste retires its slug first.
const erase = fs.readFileSync(path.join(__dirname, '..', 'server', 'identity', 'account-data.js'), 'utf8');
assert.match(erase, /retireSlug\(db, p\.slug\);\s*\n\s*await db\.prepare\('DELETE FROM pastes WHERE id = \?'\)/);
console.log('agent stable ids: ok');
