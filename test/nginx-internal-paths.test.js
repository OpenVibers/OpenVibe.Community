'use strict';
// deploy/nginx/openvibe.community.conf: the vhost itself refuses /metrics (with or without a trailing
// slash) and the whole /internal/ tree (Events ingestion), rather than leaning on the app's
// forwarding-header check. The old exact-match `location = /metrics` left `/metrics/` (which Express
// still routes to /metrics) and `/internal/events` falling through to the catch-all `location /`.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'openvibe.community.conf'), 'utf8');
assert.ok(!/location = \/metrics/.test(conf), 'the exact-match /metrics block is gone (it let /metrics/ through)');
assert.match(conf, /location ~\* \^\/metrics\(\/\|\$\) \{ return 404; \}/, '/metrics in any case, with or without a slash');
assert.match(conf, /location ~\* \^\/internal\(\/\|\$\) \{ return 404; \}/, '/internal in any case');
// The HTTPS catch-all is the last `location / {` (the port-80 block has one earlier).
const catchAll = conf.lastIndexOf('location / {');
assert.ok(conf.indexOf('location ~* ^/metrics(/|$)') < conf.indexOf('location ~ ^/(?!api/|auth/)'), 'the metrics block precedes the static-asset regex');
assert.ok(conf.indexOf('location ~* ^/internal(/|$)') < conf.indexOf('location ~ ^/(?!api/|auth/)'), 'the internal block precedes the static-asset regex');
console.log('nginx internal paths: /metrics and /internal/ are blocked in the vhost');
