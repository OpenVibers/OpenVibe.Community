'use strict';
// The shared update system on openvibe.community: the home shows what shipped, /updates is the log
// (openvibe-shared/frame markup, the same on every OpenVibe site), the footer links it, and the
// shared navbar signs out through this site (logoutUrl).
const assert = require('assert');
const pages = require('../server/render/pages');

const home = pages.homePage({ latest: [], trending: [], languages: [], user: null });
assert.ok(home.includes('data-ov-shipped="latest" data-service="community" href="/updates"'), 'home pill');
assert.ok(home.includes('data-ov-shipped="list" data-service="community"'), 'home recent list');
assert.ok(home.includes('"logoutUrl":"/auth/logout?next={path}"'));
assert.ok(home.includes('"updates":"/updates"'));
const up = pages.updatesPage();
assert.ok(up.includes('What shipped on OpenVibe.Community') && up.includes('data-ov-shipped="log" data-service="community"'));
assert.ok(/<link rel="canonical" href="[^"]*\/updates">/.test(up));
console.log('shipped pages: all checks passed');
