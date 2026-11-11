'use strict';

const ld = require('./jsonld');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { card } = require('../pulse/feed');

const KINDS = [['', 'For you'], ['live', 'Live'], ['clip', 'Clips'], ['video', 'Videos'], ['pic', 'Pics'], ['post', 'Posts'], ['meme', 'Memes'], ['game', 'Games'], ['update', 'Updates']];
const href = (kind, cursor = '', search = '') => { const q = new URLSearchParams(); if (kind) q.set('kind', kind); if (search) q.set('q', search); if (cursor) q.set('cursor', cursor); return `/feed${q.size ? `?${q}` : ''}`; };

function feedPage({ items = [], kind = '', q = '', examples = [], cursor = null, nextCursor = null } = {}) {
    const cards = items.map((item) => item && item.kind ? item : card(item));
    const chips = KINDS.map(([id, label]) => `<a class="tab${id === kind ? ' active' : ''}" href="${esc(href(id, '', q))}"${id === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    const body = `<header class="page-head"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Feed</span></nav><h1>Feed</h1><p class="muted">What's happening across OpenVibe.</p></header>
<form action="/feed" method="get" role="search"><label for="feed-search">Search the feed</label><input id="feed-search" type="search" name="q" value="${esc(q)}" placeholder="People, clips, sites, dates" maxlength="80">${kind ? `<input type="hidden" name="kind" value="${esc(kind)}">` : ''}<button type="submit">Search</button></form>
${examples.length ? `<p class="muted">Try: ${examples.map((x) => `<a href="${esc(href('', '', x.text))}">${esc(x.text)}</a>`).join(' · ')}</p>` : ''}
<nav class="tabs sort-tabs feed-kind-tabs" aria-label="Feed type">${chips}</nav>
<ol class="thread-list pulse-list">${cards.map((c) => `<li class="pulse-item"><span class="badge pulse-source">${esc(c.site_name)} · ${esc(c.kind)}</span><div class="pulse-main"><a class="thread-title" href="${esc(c.url)}">${esc(c.title)}</a>${c.text ? `<p>${esc(c.text)}</p>` : ''}${c.media ? `<img src="${esc(c.media.thumb)}" alt="" loading="lazy" decoding="async">` : ''}<p class="thread-meta">${c.actor ? `${esc(c.actor.name || '')} · ` : ''}<time datetime="${esc(c.at || '')}">${esc(c.at || '')}</time></p></div></li>`).join('')}</ol>
${cursor || nextCursor ? `<nav class="pager" aria-label="Feed pages">${cursor ? `<a href="${esc(href(kind, '', q))}">Latest</a>` : '<span></span>'}<span></span>${nextCursor ? `<a rel="next" href="${esc(href(kind, nextCursor, q))}">Older</a>` : '<span></span>'}</nav>` : ''}`;
    const itemsLd = cards.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'OpenVibe Feed', url: 'https://openvibe.community/feed', itemListElement: cards.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.title, url: c.url })) }] : [];
    return renderPage({ title: `Feed${kind ? ` — ${KINDS.find(([id]) => id === kind)?.[1] || kind}` : ''}`, description: 'New clips, videos, pictures, posts, live streams and updates from across OpenVibe.', canonicalPath: href(kind), robots: cursor || q || !cards.length ? 'noindex,follow' : 'index,follow', active: 'pulse', jsonLd: [ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Feed', url: '/feed' }]), ...itemsLd], body });
}

module.exports = { feedPage };
