'use strict';
/**
 * The plain-page sweep (owner ask 81): the pages that used to print a bare "No X yet" draw the shared kit's
 * empty state instead, and the one next action is a kit button. Each page that can show one loads kit.css.
 */
const assert = require('assert');
const { pulsePage } = require('../server/render/pulse');
const { boardIndexPage, forumSpacePage } = require('../server/render/board');
const { searchPage } = require('../server/render/search');
const { submissionsPage, reviewQueuePage } = require('../server/render/submissions');
const { cardGrid } = require('../server/render/pages');

const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);
const emptyState = (html, title) => {
    has(html, 'class="ovk-empty"');
    has(html, title);
    has(html, 'kit.css');
};

const space = { slug: 'empty', name: 'Empty', description: '', visibility: 'public', members_only: 0, style: 'forum', thread_kind: 'topic', statuses: [] };

const checks = [
    ['the board index with no forum', () => {
        const html = boardIndexPage({ groups: [] });
        emptyState(html, 'No forums yet');
        has(html, 'See what is happening');
        has(html, 'ovk-btn');
    }],
    ['a forum with no topic', () => {
        const html = forumSpacePage({ space, threads: [], page: 1, pages: 1, total: 0, viewer: { can_start: true } });
        emptyState(html, 'No topics yet');
        has(html, 'Start the first topic');
    }],
    ['a filtered forum with no match', () => {
        const html = forumSpacePage({ space, threads: [], page: 1, pages: 1, total: 0, category: 'other', viewer: { can_start: true } });
        emptyState(html, 'Nothing here yet');
        has(html, 'See every topic');
    }],
    ['Pulse with nothing', () => {
        const html = pulsePage({ items: [] });
        emptyState(html, 'Nothing here yet');
        has(html, 'Visit the forum');
    }],
    ['Search before a query', () => {
        const html = searchPage({ q: '', results: [] });
        emptyState(html, 'Search Community');
        has(html, 'Browse the forum');
    }],
    ['Search with no match', () => {
        const html = searchPage({ q: 'zzz', results: [] });
        emptyState(html, 'Nothing matches');
        has(html, 'Search the whole network');
    }],
    ['Search not answering', () => {
        const html = searchPage({ q: 'zzz', results: [], unavailable: true });
        emptyState(html, 'Search is not answering');
        has(html, 'Filter pastes');
    }],
    ['Submissions with nothing accepted', () => {
        const html = submissionsPage({ items: [] });
        emptyState(html, 'Nothing accepted yet');
        has(html, 'Sign in to submit');
    }],
    ['the review queue with nothing waiting', () => {
        const html = reviewQueuePage({ items: [] });
        emptyState(html, 'Nothing to review');
        has(html, 'See submissions');
    }],
    ['a paste grid with nothing', () => {
        const html = cardGrid([], { title: 'No pastes yet', text: 'No paste has been shared here yet.', action: { href: '/new', label: 'Make a paste', icon: 'plus' } });
        has(html, 'class="ovk-empty"');
        has(html, 'No pastes yet');
        has(html, 'Make a paste');
    }],
];

let failed = 0;
for (const [name, run] of checks) {
    try { run(); console.log(`ok - ${name}`); }
    catch (e) { failed += 1; console.error(`not ok - ${name}: ${e.message}`); }
}
process.exitCode = failed ? 1 : 0;
