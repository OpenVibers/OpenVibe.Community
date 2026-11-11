'use strict';

const ld = require('./jsonld');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { card } = require('../pulse/feed');

const KINDS = [['', 'For you'], ['live', 'Live'], ['clip', 'Clips'], ['video', 'Videos'], ['pic', 'Pics'], ['post', 'Posts'], ['meme', 'Memes'], ['game', 'Games'], ['update', 'Updates']];
const href = (kind) => kind ? `/feed?kind=${encodeURIComponent(kind)}` : '/feed';

function feedPage({ items = [], kind = '' } = {}) {
    const cards = items.map(card);
    const chips = KINDS.map(([id, label]) => `<a class="tab${id === kind ? ' active' : ''}" href="${href(id)}"${id === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    const body = `<header class="page-head"><nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Feed</span></nav><h1>Feed</h1><p class="muted">What's happening across OpenVibe.</p></header>
<nav class="tabs sort-tabs" aria-label="Feed type">${chips}</nav>
<ol class="thread-list pulse-list">${cards.map((c) => `<li class="pulse-item"><span class="badge pulse-source">${esc(c.site_name)} · ${esc(c.kind)}</span><div class="pulse-main"><a class="thread-title" href="${esc(c.url)}">${esc(c.title)}</a>${c.text ? `<p>${esc(c.text)}</p>` : ''}${c.media ? `<img src="${esc(c.media.thumb)}" alt="" loading="lazy" decoding="async">` : ''}<p class="thread-meta">${c.actor ? `${esc(c.actor.name || '')} · ` : ''}<time datetime="${esc(c.at || '')}">${esc(c.at || '')}</time></p></div></li>`).join('')}</ol>`;
    const itemsLd = cards.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'OpenVibe Feed', url: 'https://openvibe.community/feed', itemListElement: cards.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.title, url: c.url })) }] : [];
    return renderPage({ title: `Feed${kind ? ` — ${KINDS.find(([id]) => id === kind)?.[1] || kind}` : ''}`, description: 'New clips, videos, pictures, posts, live streams and updates from across OpenVibe.', canonicalPath: href(kind), robots: cards.length ? 'index,follow' : 'noindex,follow', active: 'pulse', jsonLd: [ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Feed', url: '/feed' }]), ...itemsLd], body });
}

module.exports = { feedPage };
