'use strict';
// A neighbour service's direct call is not counted in Community's per-address /api/ limit (11-28: every service on the
// machine shared one 120-a-minute bucket; a crawler on OpenVibe.Deals starved its comment reads). Only a loopback
// request with no X-Forwarded-For is one: nginx sets that header on every proxied request.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isInternalCaller } = require('../server/http/internal-caller');

const req = (addr, headers = {}) => ({ headers, socket: { remoteAddress: addr } });
assert.strictEqual(isInternalCaller(req('127.0.0.1')), true);
assert.strictEqual(isInternalCaller(req('::1')), true);
assert.strictEqual(isInternalCaller(req('::ffff:127.0.0.1')), true);
assert.strictEqual(isInternalCaller(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false, 'through nginx: a person or a bot');
assert.strictEqual(isInternalCaller(req('203.0.113.9')), false, 'not this machine');
assert.strictEqual(isInternalCaller({}), false);
const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
assert.match(app, /app\.use\('\/api\/', rateLimit\(\{[^}]*skip: \(req\) => isInternalCaller\(req\)/, 'the /api/ limit skips them');
console.log('internal-caller: a neighbour service is not counted in the per-address /api/ limit; people and bots are');
