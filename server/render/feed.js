'use strict';

const ld = require('./jsonld');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { card } = require('../pulse/feed');

// What each kind is called on a card and its mark (Opus, 2026-11-11: "Live · video" and "Quest · quest" said the same
// thing twice; a card now says what happened, who, where and when, in one line).
const KIND_LOOK = {
    live: ['Live now', 'fa-tower-broadcast'], video: ['Recording', 'fa-film'], clip: ['Clip', 'fa-scissors'], pic: ['Picture', 'fa-image'],
    post: ['Post', 'fa-pen-nib'], paste: ['Paste', 'fa-paste'], meme: ['Meme', 'fa-face-laugh'], game: ['Game', 'fa-gamepad'],
    quest: ['Quest', 'fa-ranking-star'], member: ['New members', 'fa-user-plus'], update: ['Update', 'fa-bolt'], avatar: ['New picture', 'fa-user'],
    banner: ['New banner', 'fa-image'], follow: ['Follow', 'fa-user-check'], site: ['New site', 'fa-globe'], space: ['Space', 'fa-shapes'],
    episode: ['Episode', 'fa-microphone'],
};
const lookOf = (kind) => KIND_LOOK[kind] || [String(kind || 'Update').replace(/^./, (c) => c.toUpperCase()), 'fa-circle-nodes'];
/** "3 min ago", "2 h ago", "yesterday", "Nov 3": when, the way a feed says it (the full date stays in the title). */
function ago(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (now - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    if (s < 172800) return 'yesterday';
    if (s < 604800) return `${Math.round(s / 86400)} days ago`;
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(now - t > 300 * 86400000 ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}
const fullDate = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toUTCString().replace(' GMT', ' UTC') : ''; };
const clock = (sec) => { const n = Math.round(Number(sec) || 0); if (!n) return ''; const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60); const x = n % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
/**
 * A folded run's pictures: its first four, each opening its own item, "+N" on the last (openvibe.design rule 136, a
 * group shows its members: "iZoR_One added 10 videos" over one picture showed one video of ten).
 */
function groupStrip(c) {
    const items = (c.group.items || []).filter((x) => x.media && x.media.thumb).slice(0, 4);
    if (items.length < 2) return '';
    const more = Math.max(0, Number(c.group.count) - items.length);
    return `<ul class="feed-strip" data-n="${items.length}">${items.map((x, i) => `<li><a href="${esc(x.url)}"${x.title ? ` title="${esc(x.title)}"` : ''}>`
        + `<img src="${esc(x.media.thumb)}" alt="${esc(x.title || '')}" loading="lazy" decoding="async">`
        + `${i === items.length - 1 && more ? `<span class="feed-strip-more">+${more}</span>` : ''}</a></li>`).join('')}</ul>`;
}

/** One card: its mark, who and what, where and when on one line; the title; the line; the picture at its own shape. */
function feedCard(c, now) {
    const [one, icon] = lookOf(c.kind);
    const what = c.group && !/s$/.test(one) ? `${one}s` : one;
    const who = c.actor && c.actor.name ? `<span class="feed-who">${c.actor.avatar ? `<img src="${esc(c.actor.avatar)}" alt="" width="20" height="20" loading="lazy" decoding="async">` : ''}${esc(c.actor.name)}</span>` : '';
    const when = c.at ? `<time datetime="${esc(c.at)}" title="${esc(fullDate(c.at))}">${esc(ago(c.at, now))}</time>` : '';
    const ratio = c.media && Number(c.media.ratio) > 0 ? Math.min(2.4, Math.max(0.5, Number(c.media.ratio))) : 16 / 9;
    const strip = c.group ? groupStrip(c) : '';
    const media = strip || !c.media ? strip : `<a class="feed-media${ratio < 1 ? ' is-tall' : ''}" href="${esc(c.url)}" tabindex="-1" aria-hidden="true" style="aspect-ratio:${ratio.toFixed(3)}"><img src="${esc(c.media.thumb)}" alt="" loading="lazy" decoding="async">${c.media.length ? `<span class="feed-len">${esc(clock(c.media.length))}</span>` : ''}${c.kind === 'live' ? '<span class="feed-live">LIVE</span>' : ''}</a>`;
    return `<li class="feed-item is-${esc(c.kind || 'update')}"><span class="feed-ic" aria-hidden="true"><i class="fa-solid ${icon}"></i></span><div class="feed-body">`
        + `<p class="feed-top">${who}<span class="feed-what">${esc(what)}</span>${c.site_name && !String(what).toLowerCase().startsWith(String(c.site_name).toLowerCase()) && !String(what).toLowerCase().endsWith(String(c.site_name).toLowerCase()) ? `<span class="feed-site">${esc(c.site_name)}</span>` : ''}${when}</p>`
        + `<a class="feed-title" href="${esc(c.url)}">${esc(c.title)}</a>${c.text ? `<p class="feed-text">${esc(c.text)}</p>` : ''}${media}</div></li>`;
}

const KINDS = [['', 'For you'], ['live', 'Live'], ['clip', 'Clips'], ['video', 'Videos'], ['pic', 'Pics'], ['post', 'Posts'], ['paste', 'Pastes'], ['meme', 'Memes'], ['game', 'Games'], ['update', 'Updates']];
const href = (kind, cursor = '', search = '') => { const q = new URLSearchParams(); if (kind) q.set('kind', kind); if (search) q.set('q', search); if (cursor) q.set('cursor', cursor); return `/feed${q.size ? `?${q}` : ''}`; };

function feedPage({ items = [], kind = '', q = '', examples = [], cursor = null, nextCursor = null, now = Date.now() } = {}) {
    const cards = items.map((item) => item && item.kind ? item : card(item));
    const chips = KINDS.map(([id, label]) => `<a class="tab${id === kind ? ' active' : ''}" href="${esc(href(id, '', q))}"${id === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    const body = `<header class="page-head"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Feed</span></nav><h1>Feed</h1><p class="muted">What's happening across OpenVibe.</p></header>
<form class="feed-find" action="/feed" method="get" role="search"><label for="feed-search" class="sr-only">Search the feed</label><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="feed-search" type="search" name="q" value="${esc(q)}" placeholder="People, clips, sites, dates" maxlength="80">${kind ? `<input type="hidden" name="kind" value="${esc(kind)}">` : ''}<button type="submit">Search</button></form>
${examples.length ? `<p class="feed-try"><span>Try</span>${examples.map((x) => `<a href="${esc(href('', '', x.text))}">${esc(x.text)}</a>`).join('')}</p>` : ''}
<nav class="tabs sort-tabs feed-kind-tabs" aria-label="Feed type">${chips}</nav>
${cards.length ? `<ol class="feed-list">${cards.map((c) => feedCard(c, now)).join('')}</ol>` : `<div class="feed-empty"><i class="fa-solid fa-wind" aria-hidden="true"></i><p><strong>${q ? 'Nothing in the feed matches that.' : 'Nothing here yet.'}</strong></p><p class="muted">${q ? 'Try a name, a site or a date.' : 'New clips, videos, pictures and posts land here as they happen.'}</p>${q || kind ? `<a class="btn" href="/feed">The whole feed</a>` : ''}</div>`}
${cursor || nextCursor ? `<nav class="pager" aria-label="Feed pages">${cursor ? `<a href="${esc(href(kind, '', q))}">Latest</a>` : '<span></span>'}<span></span>${nextCursor ? `<a rel="next" href="${esc(href(kind, nextCursor, q))}">Older</a>` : '<span></span>'}</nav>` : ''}`;
    const itemsLd = cards.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'OpenVibe Feed', url: 'https://openvibe.community/feed', itemListElement: cards.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.title, url: c.url })) }] : [];
    return renderPage({ title: `Feed${kind ? ` — ${KINDS.find(([id]) => id === kind)?.[1] || kind}` : ''}`, description: 'New clips, videos, pictures, posts, live streams and updates from across OpenVibe.', canonicalPath: href(kind), robots: cursor || q || !cards.length ? 'noindex,follow' : 'index,follow', active: 'pulse', jsonLd: [ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Feed', url: '/feed' }]), ...itemsLd], body });
}

module.exports = { feedPage, ago };
