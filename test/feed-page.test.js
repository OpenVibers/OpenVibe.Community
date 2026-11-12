'use strict';

const assert = require('assert');
const { feedPage } = require('../server/render/feed');

const page = feedPage({ kind: 'video', cursor: 'page-one', nextCursor: 'page-two', items: [{ id: 'f:media-hub:video:3', kind: 'video', url: 'https://openvibe.video/watch/3', title: 'A video', text: 'Fresh upload', at: '2026-11-10T12:00:00.000Z', site: 'media-hub', site_name: 'Video', actor: { name: 'Ada', avatar: null }, subject: null, media: { thumb: 'https://openvibe.media/thumb.webp', ratio: 1.777 }, counts: {} }] });
assert.match(page, /href="\/feed\?kind=video" aria-current="page"/);
assert.match(page, /A video/);
assert.match(page, /Fresh upload/);
assert.match(page, /https:\/\/openvibe\.video\/watch\/3/);
assert.match(page, /"@type":"ItemList"/);
assert.match(page, /https:\/\/openvibe\.media\/thumb\.webp/);
assert.match(page, /href="\/feed\?kind=video&amp;cursor=page-two"/);
console.log('feed page markup and ItemList JSON-LD passed');
