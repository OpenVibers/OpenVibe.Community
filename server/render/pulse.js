'use strict';

/**
 * /pulse — the one OpenVibe feed, the same one the menu's Feed tab shows.
 *
 * The page is a mount for the shared feed (openvibe-shared/ov-home.js, OpenVibeHome.feed): the menu's own
 * component, on the same Network feed through the same proxy (server/feed/proxy.js), so the two can never
 * drift apart. Community's own Pulse list — its tabs, its rows, its "Older" links — is gone: there is one
 * feed, and this is where it is read.
 *
 * The first page is rendered here as well, for the crawlers and for a reader whose JavaScript does not run:
 * plain cards (the title, the site, when it happened, the link). The script replaces them with the shared
 * ones. When Network does not answer, the page still renders and says the feed is loading.
 */
const ld = require('./jsonld');
const { renderPage, asset } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { ago } = require('./feed');

// The sites the feed names, for a card that says where it came from.
const SITE_NAMES = {
    community: 'Community', live: 'Live', media: 'Media', network: 'Network', tools: 'Tools', games: 'Games',
    wiki: 'Wiki', blog: 'Blog', reviews: 'Reviews', report: 'Report', quest: 'Quest', chat: 'Chat',
    events: 'Events', news: 'News',
};

/** The address a card carries: a real link, never a script. */
function linkOf(url) {
    try {
        const u = new URL(String(url));
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#';
    } catch { return '#'; }
}

/** One plain card: the title as the link, the site it came from, and when it happened. */
function pulseCard(item, now) {
    const site = item.site_name || SITE_NAMES[item.site] || item.site || 'OpenVibe';
    const when = item.at ? `<time datetime="${esc(item.at)}" title="${esc(item.at)}">${esc(ago(item.at, now))}</time>` : '';
    // The site's own thread rows: the shared feed replaces them in the browser, so they only have to read well.
    return `<li class="thread-row pulse-card"><div class="thread-main"><a class="thread-title" href="${esc(linkOf(item.url))}">${esc(item.title || 'Untitled')}</a>`
        + `<p class="thread-meta">${esc(site)}${when ? ` · ${when}` : ''}</p></div></li>`;
}

/** The wall the shared feed falls back to when the feed does not answer: this page's own rows. */
const seedOf = (items) => items.map((i) => ({
    title: i.title, url: i.url, at: i.at, occurred_at: i.at, service: i.site, via: i.site_name, origin: i.origin,
}));

function pulsePage({ items = [], now = Date.now() } = {}) {
    const rows = (items || []).filter((i) => i && i.title && i.url);
    const seed = JSON.stringify(seedOf(rows)).replace(/</g, '\\u003c');
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <i data-ov-icon="chevron" aria-hidden="true"></i> <span aria-current="page">Pulse</span></nav>
  <h1>Pulse</h1>
  <p class="muted">What is happening across OpenVibe, newest first — the same feed the menu shows.</p>
</header>
<div id="ov-pulse-feed" data-ov-feed>${rows.length
        ? `<ol class="thread-list pulse-cards">${rows.map((i) => pulseCard(i, now)).join('')}</ol>`
        : '<p class="muted" data-ov-feed-note>Loading the feed…</p>'}</div>
<script type="application/json" id="ov-pulse-seed">${seed}</script>
<script src="${asset('js/pulse.js')}" defer></script>`;
    return renderPage({
        title: 'Pulse: what is happening across OpenVibe',
        description: 'What is happening across OpenVibe right now: new clips, videos, pictures, posts and live streams from every site, newest first — the same feed the menu shows.',
        canonicalPath: '/pulse',
        robots: 'index,follow',
        active: 'pulse',
        styles: ['kit.css'],
        // The shared feed itself (openvibe-shared/ov-home.js), served from this site's own pinned copy.
        scripts: ['ov-home.js'],
        jsonLd: [ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pulse', url: '/pulse' }])],
        body,
    });
}

module.exports = { pulsePage, pulseCard, linkOf };
