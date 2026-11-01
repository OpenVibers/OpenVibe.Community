'use strict';
// WCAG 2.1 AA (aria-prohibited-attr): an aria-label on an <i> with no role is prohibited. The pin and lock
// icons are decorative; the words sit in sr-only text inside the heading, so screen readers still say them.
//   node test/board-pin-icon.test.js
const assert = require('assert');
const board = require('../server/render/board');

const html = String(board.forumTopicPage({
    space: { slug: 'general', name: 'General', visibility: 'public', votes: false, statuses: [] },
    thread: { slug: 'welcome', title: 'Welcome', pinned: true, locked: true, reply_count: 0, views: 0, created_at: '2026-01-01T00:00:00Z' },
    posts: [], page: 1, pages: 1, viewer: {}, user: null,
}));
const h1 = html.slice(html.indexOf('<h1>'), html.indexOf('</h1>') + 5);
assert.ok(h1.includes('<i class="fa-solid fa-thumbtack" title="Pinned" aria-hidden="true"></i><span class="sr-only">Pinned</span>'), 'the pin icon is hidden; the word is in the heading');
assert.ok(h1.includes('<i class="fa-solid fa-lock" title="Locked" aria-hidden="true"></i><span class="sr-only">Locked</span>'), 'the lock icon is hidden; the word is in the heading');
assert.ok(!h1.includes('aria-label='), 'no aria-label on the role-less icons');
console.log('board pin: the icons are hidden, the words read');
