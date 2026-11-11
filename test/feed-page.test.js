'use strict';

const assert = require('assert');
const { feedPage } = require('../server/render/feed');

const page = feedPage({ kind: 'video', items: [{ source: { service: 'media-hub', type: 'video' }, id: 3, url: 'https://openvibe.video/watch/3', title: 'A video', text: 'Fresh upload', occurred_at: '2026-11-10 12:00:00', picture_url: 'https://openvibe.media/thumb.webp', actor: { display_name: 'Ada' } }] });
assert.match(page, /href="\/feed\?kind=video" aria-current="page"/);
assert.match(page, /A video/);
assert.match(page, /Fresh upload/);
assert.match(page, /https:\/\/openvibe\.video\/watch\/3/);
assert.match(page, /"@type":"ItemList"/);
assert.match(page, /https:\/\/openvibe\.media\/thumb\.webp/);
console.log('feed page markup and ItemList JSON-LD passed');
