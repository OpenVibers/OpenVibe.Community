'use strict';

/**
 * Page templates. Plain template strings, every user value escaped, no framework. The markup
 * is the whole page for crawlers and no-JS readers; public/js/community.js only adds the
 * comforts (copy, in-place pagination, the create form's upload path).
 */
const config = require('../config');
const ovServe = require('openvibe-shared/serve');
const ld = require('./jsonld');
const { renderPage, asset, SITE_NAME, DEFAULT_OG_IMAGE } = require('./layout');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const kit = require('openvibe-shared/kit');
const { highlight, escapeHtml: esc, languageLabel, extensionFor, LANGUAGES } = require('./highlight');
const { renderMarkdown } = require('./markdown');
const { canonicalSlug } = require('../pastes/url');
const pastePathSlug = (p) => (p && (p.canonical_slug || canonicalSlug(p))) || '';

// Languages read as prose: their lines wrap by default (the Wrap button still toggles), so a phone shows the whole text.
const PROSE = new Set(['markdown', 'plaintext', 'text']);

const NETWORK_URL = 'https://openvibe.network';

// ── Small helpers ────────────────────────────────────────────
/** Absolute-ize a Media-relative screenshot URL. */
function mediaAbs(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return `${config.mediaUrl}${u.startsWith('/') ? '' : '/'}${u}`;
}
// A Media object is stored at full size: ask its resize ladder for the width drawn here (96 for the 22 px author
// avatar, 160 for the 64 px postbit one). Any other picture address — the network's avatar endpoint, a picture that
// already carries a query — is used unchanged.
function mediaW(u, w) {
    return /^https:\/\/openvibe\.media\/o\/med_[0-9A-Za-z]+$/.test(String(u || '')) ? `${u}?w=${w}` : u;
}
/** A screenshot's address: Community's checked proxy, never the Media object's own URL. */
function screenshotSrc(p) { return `/p/${encodeURIComponent(pastePathSlug(p))}/screenshot`; }
/** A card-sized screenshot through the same proxy: Media's ladder has 320 and 640, webp by URL. */
function screenshotVariant(p, w) { return `${screenshotSrc(p)}?w=${w}&fmt=webp`; }
/** A card screenshot: two widths, the card's shape in width/height (no shift), lazy unless it is the LCP. */
function screenshotImg(p, { eager = false, sizes = '(max-width: 620px) calc(100vw - 40px), 300px' } = {}) {
    const srcset = [320, 640].map((w) => `${screenshotVariant(p, w)} ${w}w`).join(', ');
    return `<img src="${esc(screenshotVariant(p, 640))}" srcset="${esc(srcset)}" sizes="${esc(sizes)}" width="640" height="360" alt="${esc(p.title || 'Screenshot')}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
}

function timeAgo(v) {
    const iso = ld.isoDate(v);
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo ago`;
    return `${Math.floor(s / (86400 * 365))}y ago`;
}
function fmtDate(v) {
    const iso = ld.isoDate(v);
    if (!iso) return '';
    return new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');
}
function timeTag(v) {
    const iso = ld.isoDate(v);
    return iso ? `<time datetime="${esc(iso)}" title="${esc(fmtDate(v))}">${esc(timeAgo(v))}</time>` : '';
}
function num(n) { return Number(n || 0).toLocaleString('en-US'); }
function authorName(p) { return p.display_name || p.username || 'Anonymous'; }
/** A person's picture at `size` px: their own, else the network's avatar address (a generated initial when none). */
function avatarUrl(p, size = 96) {
    if (!p) return null;
    if (p.avatar_url) return /^https?:\/\//i.test(p.avatar_url) ? p.avatar_url : `${config.liveUrl}${p.avatar_url.startsWith('/') ? '' : '/'}${p.avatar_url}`;
    return p.username ? `${config.networkUrl}/avatar/${encodeURIComponent(p.username)}?s=${size}` : null;
}
// A person's Network subject: their name then wears what they wear (openvibe-shared items.js, loaded by community.js).
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
function wearerOf(p) {
    if (!p || p.is_ai || p.is_relay || p.is_system || p.origin === 'ai') return null;
    const s = p.subject || p.owner_subject || p.author_subject || null;
    return SUBJECT_RE.test(String(s || '')) ? s : null;
}
/** A name as escaped text, inside a span marked with its person's subject when it has one (for items.js). */
const wearName = (p, text) => { const w = wearerOf(p); return w ? `<span data-ov-subject="${esc(w)}">${esc(text)}</span>` : esc(text); };
function authorHtml(p, { link = true } = {}) {
    const name = authorName(p);
    const initial = esc(name.trim()[0] || '?').toUpperCase();
    const avatarSrc = p.avatar_url ? (/^https?:\/\//i.test(p.avatar_url) ? p.avatar_url : `${config.liveUrl}${p.avatar_url.startsWith('/') ? '' : '/'}${p.avatar_url}`) : null;
    // No picture on the paste's own record: the network's avatar address answers for any account (the person's
    // picture, or a generated initial), so an author looks the same here as on every other OpenVibe site.
    const netAvatar = !avatarSrc && p.username ? `${config.networkUrl}/avatar/${encodeURIComponent(p.username)}?s=44` : null;
    const avatar = (avatarSrc || netAvatar)
        ? `<img class="avatar" src="${esc(mediaW(avatarSrc || netAvatar, 96))}" alt="" loading="lazy" width="22" height="22">`
        : `<span class="avatar avatar-letter" aria-hidden="true">${initial}</span>`;
    const wearer = wearerOf(p);
    const inner = `${avatar}${wearer ? wearName(p, name) : `<span>${esc(name)}</span>`}`;
    if (!link || !p.username) return `<span class="author">${inner}</span>`;
    return `<a class="author" href="${esc(config.liveUrl)}/@${encodeURIComponent(p.username)}" rel="author">${inner}</a>`;
}
function langBadge(p) {
    if (p.type === 'screenshot') return `<span class="badge badge-lang"><i class="fa-solid fa-image" aria-hidden="true"></i> image</span>`;
    const l = p.language || 'text';
    return `<a class="badge badge-lang" href="/pastes?lang=${encodeURIComponent(l)}">${esc(languageLabel(l))}</a>`;
}
function pagerHref(state, page) {
    const q = new URLSearchParams();
    if (state.q) q.set('q', state.q);
    if (state.sort && state.sort !== 'new') q.set('sort', state.sort);
    if (state.lang) q.set('lang', state.lang);
    if (state.type && state.type !== 'pastes') q.set('type', state.type);
    if (state.from && state.from !== 'people') q.set('from', state.from);
    if (page > 1) q.set('page', String(page));
    const s = q.toString();
    return `/pastes${s ? `?${s}` : ''}`;
}

// ── Paste card (grid item) ───────────────────────────────────
function pasteCard(p, { eager = false } = {}) {
    const isShot = p.type === 'screenshot';
    const locked = !!p.locked;
    const preview = locked
        ? `<div class="card-locked"><i class="fa-solid fa-lock" aria-hidden="true"></i> Locked — OpenVibe can’t read what’s inside</div>`
        : isShot
            ? (p.screenshot_url ? `<div class="card-shot">${screenshotImg(p, { eager })}</div>` : '')
            : `<pre class="card-code" aria-hidden="true">${esc(String(p.content || '').slice(0, 220))}${String(p.content || '').length > 220 ? '…' : ''}</pre>`;
    const flags = `${p.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned"></i> ' : ''}${p.burn_after_read ? '<i class="fa-solid fa-fire" title="Burns after reading"></i> ' : ''}${locked ? '<i class="fa-solid fa-lock" title="Locked"></i> ' : ''}${p.is_nsfw ? '<span class="badge badge-nsfw">NSFW</span> ' : ''}`;
    return `<article class="card${p.is_nsfw ? ' card-nsfw' : ''}${locked ? ' card-is-locked' : ''}">
  <a class="card-link" href="/p/${esc(pastePathSlug(p))}">
    ${preview}
    <h3 class="card-title">${flags}${esc(p.title || (locked ? 'A locked paste' : 'Untitled'))}</h3>
  </a>
  <div class="card-meta">
    ${authorHtml(p)}
    <span class="card-right">${langBadge(p)}<span class="stat" title="Views"><i class="fa-solid fa-eye" aria-hidden="true"></i> ${num(p.views)}</span>${timeTag(p.created_at)}</span>
  </div>
</article>`;
}
function cardGrid(pastes, empty = 'Nothing here yet.') {
    if (!pastes || !pastes.length) return `<p class="empty">${esc(empty)}</p>`;
    // The first picture in the grid is the one above the fold: it loads at high priority, the rest stay lazy.
    const firstShot = pastes.findIndex((p) => p.type === 'screenshot' && p.screenshot_url && !p.locked);
    return `<div class="grid">${pastes.map((p, i) => pasteCard(p, { eager: i === firstShot })).join('\n')}</div>`;
}

// ── Home ─────────────────────────────────────────────────────
// The front page is a taste and a door, not the index (owner 2026-10-29: pages "so dang long"; a phone should "act more
// like an app"): what Community is and the two things to do first, the numbers as one strip, the newest pastes and the
// moments from streams as rails of the shared kit's cards (openvibe-shared kit.rail + kit.card, room.css) with See all
// and the kinds as quick filters, the forum's places as a launcher (showcase.apps), the roadmap and Pulse as short lists,
// and the parts read once (the API) folded. The full lists live on /pastes, /forum, /forum/roadmap and /pulse.
const TERMINAL = `$ curl -F 'content=<build.log' \\
    https://openvibe.community/api/pastes
{ "slug": "amber-fox-42",
  "url": "/p/amber-fox-42", … }`;

// Questions on the home page, each true of what runs today; the FAQPage JSON-LD repeats exactly these.
const HOME_FAQ = [
    { q: 'Do I need an account?', a: 'No. Anyone can read, and anyone can post a public paste. Sign in with your OpenVibe account to edit or delete your pastes, comment, start forum threads and keep your pastes in one list.' },
    { q: 'What can I paste?', a: 'Code, logs, configs and notes, with highlighting for every common language, a raw link and a download. You can also drop a screenshot: its location data is removed before it is stored.' },
    { q: 'Who can see my paste?', a: 'A public paste is listed and can be found in search. An unlisted one is reachable only by its link, and a paste can burn after it is read once.' },
    { q: 'Can I paste from a script?', a: 'Yes. Send the file to /api/pastes with curl or fetch, as the examples on this page show. No key is needed for a public paste; send your OpenVibe token to keep it under your account.' },
    { q: 'What is the roadmap?', a: 'OpenVibe\'s public plan, one forum thread per item, marked in progress or done. Reply to an item to ask about it or argue for it, and suggest something new in the Feedback forum.' },
    { q: 'What is Pulse?', a: 'One feed of what is happening across the OpenVibe network: who went live, new blog posts, new pastes and forum threads.' },
];

const STATUS_WORDS = { in_progress: 'In progress', done: 'Done', planned: 'Planned', open: 'Open', paused: 'Paused', declined: 'Declined' };
const STATUS_TONE = { in_progress: 'accent', done: 'ok', planned: '', open: '', paused: 'warn', declined: 'bad' };
const SERVICE_WORDS = { community: 'Community', live: 'Live', blog: 'Blog', wiki: 'Wiki', news: 'News', games: 'Games', media: 'Media', 'media-hub': 'Video', video: 'Video', pics: 'Pics', meme: 'Meme', network: 'Network', today: 'Today', tools: 'Tools', reviews: 'Reviews', quest: 'Quest', chat: 'Chat' };
// The site an item came from, as the kit's icon beside the person's picture (or alone, where no person did it).
const SERVICE_ICON = { community: 'chat', live: 'live', blog: 'book', wiki: 'book', news: 'flag', games: 'game', media: 'video', 'media-hub': 'video', video: 'video', pics: 'image', meme: 'image', network: 'members', today: 'calendar', tools: 'grid', reviews: 'star', quest: 'trophy', chat: 'chat' };
// A roadmap item's state as the row's mark: the word is under the title, once, in plain text.
const STATUS_ICON = { in_progress: 'steps', done: 'check', planned: 'clock', open: 'flag', paused: 'pause', declined: 'close' };
// The forum's places in the launcher: the network's ring icons (openvibe-shared ov-icons) by space.
const SPACE_ICON = { general: 'ov:chat', help: 'ov:help', feedback: 'ov:bell', showcase: 'ov:image', 'off-topic': 'ov:community' };

/** The numbers: only real, non-zero counts, as one strip (kit.stats; it scrolls sideways on a phone). */
function homeStats(c = {}) {
    return kit.stats([
        [Number(c.pastes) || 0, 'public pastes'],
        [Number(c.shipped) || 0, 'roadmap items shipped'],
        [Number(c.building) || 0, 'being built now'],
        [Number(c.pulse) || 0, 'updates in Pulse'],
    ], { label: 'OpenVibe.Community in numbers' });
}

/**
 * A paste as the kit's card: its picture when it is a screenshot (never an NSFW one: that card shows the paste icon and
 * says NSFW), else its first lines in the media (kit.card preview; the lists carry 300 characters) with its language in
 * the corner; who, views and when under the title.
 */
function pasteKitCard(p, { eager = false } = {}) {
    const isShot = p.type === 'screenshot';
    const image = isShot && !p.is_nsfw ? screenshotVariant(p, 640) : '';
    const card = kit.card({
        href: `/p/${pastePathSlug(p)}`, title: p.title || 'Untitled', type: 'post', ratio: '16/9', image: image || '',
        badge: p.is_nsfw ? 'NSFW' : p.origin === 'ai' ? 'AI' : p.pinned ? 'Pinned' : '',
        corner: isShot ? '' : languageLabel(p.language || 'text'),
        preview: !isShot && !p.is_nsfw ? `${String(p.content || '')}${p.more_like_it ? `\n and ${p.more_like_it} more like it` : ''}` : '',
        who: authorName(p), avatar: avatarUrl(p, 68) || '',
        count: [Number(p.views) || 0, Number(p.views) === 1 ? 'view' : 'views'], when: p.created_at || null,
    });
    // kit.card's own picture is one plain <img> before the avatar; give it both card widths, the
    // shape the card draws and the LCP hint. Its markup is pinned with the shared version.
    return image ? card.replace(/<img\b[^>]*>/, screenshotImg(p, { eager, sizes: '(max-width: 620px) 80vw, 300px' })) : card;
}

/** A section's head in the rails' look (room.css): its heading and the one link to the whole list. */
function shelfHead(id, title, more) {
    return `<div class="ovk-rail-head"><h2 id="${esc(id)}">${esc(title)}</h2><a class="ovk-rail-more" href="${esc(more.href)}">${esc(more.label)}${kit.icon('chevron')}</a></div>`;
}

/** The kinds of paste as quick filters under the newest: the most viewed, then the languages people use most. */
function kindChips(languages) {
    const items = [{ href: '/pastes?sort=views', label: 'Most viewed' }].concat((languages || []).slice(0, 7).map((l) => (l.language === 'image'
        ? { href: '/pastes?type=images', label: `Images ${num(l.count)}` }
        : { href: `/pastes?lang=${encodeURIComponent(l.language)}`, label: `${languageLabel(l.language)} ${num(l.count)}` })));
    return `<nav class="cm-kinds" aria-label="Browse pastes by kind">${items.map((x) => kit.button({ ...x, kind: 'quiet', small: true })).join('')}</nav>`;
}

function latestShelf(latest, languages) {
    const list = latest || [];
    // The newest screenshot in the first rail is the home's LCP picture on a phone: load it at high priority.
    const firstShot = list.findIndex((p) => p.type === 'screenshot' && p.screenshot_url && !p.is_nsfw && !p.locked);
    const rail = kit.rail({ id: 'latest', title: 'Latest pastes', more: { href: '/pastes', label: 'See all' }, items: list.map((p, i) => pasteKitCard(p, { eager: i === firstShot })) });
    const none = `<section id="latest" aria-labelledby="latest-h">${shelfHead('latest-h', 'Latest pastes', { href: '/pastes', label: 'See all' })}${kit.empty({ title: 'No pastes yet', text: 'Be the first: paste something and share the link.', action: { href: '/new', label: 'Start a paste' } })}</section>`;
    return `<div class="cm-sec">${rail || none}${languages && languages.length ? kindChips(languages) : ''}</div>`;
}

function streamsShelf(items) {
    if (!items || !items.length) return '';
    return `<div class="cm-sec">${kit.rail({ id: 'from-streams', title: 'From streams', more: { href: '/pastes?from=streams', label: 'See all' }, items: items.map(pasteKitCard) })}
<p class="cm-note">Moments from streams on OpenVibe.Live, written up by OpenVibe.AI, each linking back to the stream.</p></div>`;
}

/** The forum's public places as a launcher: icon tiles on a phone, a row with each one's line from 600 px. */
function forumShelf(spaces) {
    if (!spaces || !spaces.length) return '';
    return showcase.apps({
        id: 'forum', title: 'The forum',
        items: spaces.slice(0, 8).map((sp) => ({
            icon: SPACE_ICON[sp.slug] || 'ov:chat', name: sp.name, href: `/forum/${sp.slug}`,
            text: `${sp.description ? `${ld.clean(sp.description, 90)} · ` : ''}${num(sp.thread_count)} ${Number(sp.thread_count) === 1 ? 'thread' : 'threads'}`,
        })),
        more: { href: '/forum', label: 'All forums' },
    });
}

const whenOf = (v) => (v ? kit.when(v) : { text: '', iso: '' });
function roadmapShelf(items) {
    if (!items || !items.length) return '';
    const mark = (st) => `<span class="cm-mark cm-mark--${esc(STATUS_TONE[st] || 'plain')}" aria-hidden="true">${kit.icon(STATUS_ICON[st] || 'flag')}</span>`;
    return `<section class="cm-sec" id="roadmap" aria-labelledby="h-roadmap">${shelfHead('h-roadmap', 'On the roadmap', { href: '/forum/roadmap', label: 'The whole roadmap' })}
${kit.list(items.slice(0, 5).map((t) => kit.row({ href: `/forum/roadmap/${t.slug}`, mark: mark(t.status), title: t.title, sub: STATUS_WORDS[t.status] || 'Open', meta: whenOf(t.last_activity_at).text, metaIso: whenOf(t.last_activity_at).iso })))}</section>`;
}

/**
 * One thing that happened on the network, as a row: the person's picture with the site's icon on its corner (the
 * site's icon alone where no person did it: a count, a system notice; a spark where OpenVibe.AI wrote it), what
 * happened, the site in words with the item's own line where it has one, and its picture at the row's end.
 */
function pulseRow(it) {
    const svc = it.source.service;
    const site = SERVICE_WORDS[svc] || (it.via ? it.via.replace(/^via /, '') : svc);
    const glyph = kit.icon(it.origin === 'ai' ? 'spark' : SERVICE_ICON[svc] || 'globe');
    const person = it.actor && !it.actor.is_ai && !it.actor.is_system ? it.actor : null;
    const mark = person
        ? `<span class="cm-pmark">${kit.mark({ name: authorName(person), src: avatarUrl(person, 96) || '', size: 40 })}<span class="cm-pmark-site" title="${esc(site)}">${glyph}</span></span>`
        : `<span class="cm-mark cm-mark--site" aria-hidden="true">${glyph}</span>`;
    const line = it.text ? ld.clean(it.text, 80) : '';
    const thumb = it.picture_url && /^https:\/\//i.test(it.picture_url) ? `<img class="cm-pthumb" src="${esc(kit.mediaW(it.picture_url, 96))}" alt="" width="44" height="44" loading="lazy" decoding="async">` : '';
    return kit.row({
        href: it.url, rel: svc === 'community' ? '' : 'nofollow ugc noopener', mark, title: it.title,
        badge: it.origin === 'ai' ? kit.badge('AI', 'accent') : '', sub: line ? `${site} · ${line}` : site, trail: thumb,
        meta: whenOf(it.occurred_at).text, metaIso: whenOf(it.occurred_at).iso,
    });
}

function pulseShelf(items) {
    if (!items || !items.length) return '';
    // Links to the network's other sites keep the nofollow they have on /pulse.
    return `<section class="cm-sec" id="pulse" aria-labelledby="h-pulse">${shelfHead('h-pulse', 'Across OpenVibe', { href: '/pulse', label: 'All of Pulse' })}
${kit.list(items.slice(0, 5).map(pulseRow))}</section>`;
}

/** The API, read once: folded, with the two samples to copy. */
function apiFold() {
    return kit.fold({
        id: 'api', title: 'Paste from a script', meta: 'curl or fetch',
        body: `<p class="cm-fold-lede">The page you use is the API a script uses: no key for public pastes. Sign in, or send your OpenVibe token, to keep them under your account.</p>
<p class="cm-snip-h">A file from a terminal</p>${kit.snippet({ id: 'api-curl', code: `curl -F 'content=<build.log' -F title='Build log' \\\n  https://openvibe.community/api/pastes` })}
<p class="cm-snip-h">JavaScript</p>${kit.snippet({ id: 'api-js', code: `const api = 'https://openvibe.community/api/pastes';
const res = await fetch(api, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Snippet', content }),
});
const { url } = await res.json(); // "/p/<slug>"` })}`,
    });
}

/**
 * The questions. Every one is in the page; on a phone the list shows its first two and fades, and one button under
 * it opens the rest (the owner, 2026-11-10: a closed fold "doesn't even look collapsible, so you can't even see the
 * questions … show the first two and then fade out"). Each question opens its own answer. Without the script, and
 * where there is room, the whole list is shown.
 */
function homeFaq() {
    const n = HOME_FAQ.length;
    const item = (f) => `<details><summary><span class="cm-faq-i" aria-hidden="true">${kit.icon('help')}</span><span class="cm-faq-q">${esc(f.q)}</span>${kit.icon('chevron', { cls: 'cm-faq-c' })}</summary><p>${esc(f.a)}</p></details>`;
    return `<section class="cm-sec" id="questions" aria-labelledby="h-faq"><div class="ovk-rail-head"><h2 id="h-faq">Questions</h2></div>
<div class="cm-peek" id="faq-peek"><div class="cm-faq">${HOME_FAQ.map(item).join('')}</div></div>
<button type="button" class="cm-peek-more" id="faq-more" aria-controls="faq-peek" aria-expanded="false" hidden><span data-more="All ${n} questions" data-less="Show fewer">All ${n} questions</span>${kit.icon('down')}</button>
<script>(function(){var p=document.getElementById('faq-peek'),b=document.getElementById('faq-more');if(!p||!b||!window.matchMedia||!window.matchMedia('(max-width:640px)').matches)return;var l=b.querySelector('span');p.setAttribute('data-clamped','');b.hidden=false;
b.addEventListener('click',function(){var open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',open?'true':'false');l.textContent=l.getAttribute(open?'data-less':'data-more');
if(open){p.style.maxHeight=p.scrollHeight+'px';p.removeAttribute('data-clamped');p.setAttribute('data-open','');setTimeout(function(){if(p.hasAttribute('data-open'))p.style.maxHeight='none'},420)}
else{p.style.maxHeight=p.scrollHeight+'px';p.offsetHeight;p.removeAttribute('data-open');p.setAttribute('data-clamped','');p.style.maxHeight='';b.scrollIntoView({block:'nearest'})}});
p.addEventListener('toggle',function(e){if(p.hasAttribute('data-clamped')){if(e.target.open)b.click()}else if(p.hasAttribute('data-open'))p.style.maxHeight='none'},true);})();</script></section>`;
}

/** The roadmap and the pulse: two sections, one under the other on a phone, side by side where there is room. */
function whatIsHappening(roadmap, activity) {
    const pair = roadmapShelf(roadmap) + pulseShelf(activity);
    return pair ? `<div class="cm-pair">${pair}</div>` : '';
}


function homePage({ latest, fromStreams = [], languages, user, spaces = [], roadmap = [], activity = [], counts = {} }) {
    const body = showcase.hero({
        title: 'Share it with a link.', accent: 'Talk about it here.',
        lede: 'Paste code, logs, configs or a screenshot and get a short link that works anywhere. No account needed to read or share.',
        // Two, side by side on a phone: the paste itself, then the list (signed in: your own; See all opens everyone's).
        actions: [
            { label: 'Start a paste', href: '/new', primary: true, icon: 'fa-plus' },
            user ? { label: 'My pastes', href: '/my', icon: 'fa-user' } : { label: 'Browse pastes', href: '/pastes', icon: 'fa-paste' },
        ],
        // The terminal beside the words on a computer; a phone skips it (community.css), and the API fold has it too.
        aside: { html: `<pre class="cm-hero-code" aria-label="Paste a file from a terminal"><code>${esc(TERMINAL)}</code></pre>` },
    }) + homeStats(counts) + `
${latestShelf(latest, languages)}
${streamsShelf(fromStreams)}
${forumShelf(spaces)}
${whatIsHappening(roadmap, activity)}
<div class="cm-sec">${apiFold()}</div>
${homeFaq()}
<section class="section">${frame.shipped({ service: 'community', title: 'Recently shipped on OpenVibe.Community' })}</section>`;
    return renderPage({
        title: 'OpenVibe.Community: pastes, forums and the OpenVibe roadmap',
        description: 'Paste code, logs or a screenshot and get a short link. Talk it over in the forum, follow the OpenVibe roadmap, and see what is happening in Pulse.',
        canonicalPath: '/',
        agentLayer: true,   // the public page has a Markdown twin (server/agent-pages.js)
        active: 'home',
        jsonLd: [
            ld.websiteLd(),
            ...(latest && latest.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: 'Latest pastes', url: `${config.baseUrl}/pastes`, itemListElement: latest.slice(0, 12).map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.title || 'Untitled', url: `${config.baseUrl}/p/${pastePathSlug(p)}` })) }] : []),
            { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: HOME_FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) },
        ],
        // The kit's controls (kit.css) and its cards and rails (room.css, after it); kit-web.js comes with community.js.
        styles: [showcase.STYLESHEET, 'kit.css', 'room.css'],
        // The rule that shows the picked shelf: one per shelf, so the CSS is written for this page.
        bodyClass: 'cm-home',
        body,
    });
}

// ── What shipped: the shared update log every OpenVibe site has ──
function updatesPage() {
    return renderPage({
        title: 'What shipped on OpenVibe.Community',
        description: 'Every change deployed to OpenVibe.Community, newest first, with the Patch notes that gather them.',
        canonicalPath: '/updates',
        body: frame.updatesBody({ service: 'community', siteName: 'OpenVibe.Community' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`,
    });
}

// ── Browse ───────────────────────────────────────────────────
function browsePage(result, languages) {
    const { pastes, total, page, pages, q, sort, lang, type = 'pastes', from = 'people', windowed, windowSize } = result;
    const titleBits = [];
    if (q) titleBits.push(`“${q}”`);
    if (lang) titleBits.push(languageLabel(lang));
    titleBits.push(sort === 'views' ? 'most viewed' : 'newest');
    const title = `Pastes — ${titleBits.join(', ')}${page > 1 ? ` (page ${page})` : ''}`;
    const canonical = pagerHref({ q, sort, lang, type, from }, page);
    const opt = (id, label) => `<option value="${esc(id)}"${id === (lang || '') ? ' selected' : ''}>${esc(label)}</option>`;
    const langOptions = [opt('', 'All languages')].concat((languages || []).map((l) => opt(l.language, `${languageLabel(l.language)} (${l.count})`)));
    if (lang && !(languages || []).some((l) => l.language === lang)) langOptions.push(opt(lang, languageLabel(lang)));

    const pager = pages > 1 ? `<nav class="pager" aria-label="Pages">
    ${page > 1 ? `<a rel="prev" href="${esc(pagerHref({ q, sort, lang, type, from }, page - 1))}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> Newer</a>` : '<span></span>'}
    <span class="pager-info">Page ${page} of ${pages}</span>
    ${page < pages ? `<a rel="next" href="${esc(pagerHref({ q, sort, lang, type, from }, page + 1))}">Older <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a>` : '<span></span>'}
  </nav>` : '';

    const body = `
<header class="page-head">
  <h1>Pastes</h1>
  <p class="muted">${num(total)} ${total === 1 ? 'paste' : 'pastes'}${from === 'streams' ? ' from streams, written up by OpenVibe.AI' : from === 'people' ? ' by people' : ''}${windowed ? ` in the latest ${windowSize}` : ''}${q ? ` matching “${esc(q)}”` : ''}</p>
</header>
<form class="filters" method="get" action="/pastes" role="search" data-browse>
  <label class="search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" name="q" value="${esc(q)}" placeholder="Search titles and content" aria-label="Search pastes"></label>
  <label>From <select name="from"><option value="people"${from === 'people' ? ' selected' : ''}>People</option><option value="streams"${from === 'streams' ? ' selected' : ''}>Streams (AI)</option><option value="all"${from === 'all' ? ' selected' : ''}>Everyone</option></select></label>
  <label>Show <select name="type"><option value="pastes"${type === 'pastes' ? ' selected' : ''}>Pastes</option><option value="images"${type === 'images' ? ' selected' : ''}>Images</option><option value="all"${type === 'all' ? ' selected' : ''}>All</option></select></label>
  <label>Sort <select name="sort"><option value="new"${sort === 'new' ? ' selected' : ''}>Newest</option><option value="views"${sort === 'views' ? ' selected' : ''}>Most viewed</option></select></label>
  <label>Language <select name="lang">${langOptions.join('')}</select></label>
  <button class="btn" type="submit">Apply</button>
  ${(q || lang || sort !== 'new' || from !== 'people') ? `<a class="btn btn-ghost" href="/pastes">Clear</a>` : ''}
</form>
<section id="results" data-results>
  ${cardGrid(pastes, q ? 'No pastes match that search.' : 'No pastes yet.')}
  ${pager}
</section>`;
    return renderPage({
        title,
        description: `Browse ${sort === 'views' ? 'the most viewed' : 'the latest'} pastes on OpenVibe.Community${lang ? ` in ${languageLabel(lang)}` : ''} — code, logs and screenshots shared by the people of OpenVibe.`,
        canonicalPath: canonical,
        agentLayer: true,   // the public page has a Markdown twin (server/agent-pages.js)
        robots: q ? 'noindex,follow' : 'index,follow',
        active: 'pastes',
        jsonLd: [ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }])],
        body,
    });
}

// ── Paste page ───────────────────────────────────────────────
function pasteDescription(p) {
    if (p.locked) return 'A locked paste on OpenVibe Community. Only the people it is locked for can read it.';
    if (p.ai_summary) return ld.clean(p.ai_summary, 200);
    if (p.type === 'screenshot') return ld.clean(p.content || `A screenshot shared by ${authorName(p)} on ${SITE_NAME}.`, 200);
    return ld.clean(`${p.title || 'Paste'} — ${languageLabel(p.language)} paste by ${authorName(p)}: ${String(p.content || '').slice(0, 200)}`, 200);
}


/**
 * comments: the paste's typed thread as the comment service shows it to this viewer (null while nobody has
 * commented); commentSort 'new' or 'old', commentsAfter the paging cursor. No comments on burn-after-read pastes.
 */
/** Letters and digits only, lower case: a heading and a title match whatever their punctuation and emoji. */
const bare = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** A document's opening # heading, dropped when it only repeats the paste's title (the page's h1 already shows it). */
function withoutTitle(content, title) {
    const text = String(content || '');
    const m = text.match(/^\s*# +([^\n]+)\n?/);
    return m && bare(m[1]) && bare(m[1]) === bare(title) ? text.slice(m[0].length) : text;
}

function pastePage({ paste: p, related, user, comments = null, commentSort = 'top', commentsAfter = null, replyId = null, expandedId = null, expandedReplies = null, share = null }) {
    const isShot = p.type === 'screenshot';
    // A locked paste (Locker design 2026-11-06, the pilot): Community holds an envelope and never the plaintext. The
    // title is here only if its owner chose to show it; the page opens the envelope in the browser.
    const locked = !!p.locked;
    const pageSlug = p.canonical_slug || canonicalSlug(p);
    const title = p.title || (locked ? 'A locked paste' : isShot ? 'Screenshot' : 'Untitled paste');
    const description = pasteDescription(p);
    // The screenshot is Community's own address: the proxy checks canView, never the Media object's URL.
    const shot = isShot ? screenshotSrc(p) : null;
    // Specific people and Only me get a generic link preview, even for someone allowed to read them:
    // a crawler or a chat client must never learn the title, the description or the picture. A locked paste always
    // does: its words are not ours to describe.
    const restricted = !!(share && (share.audience === 'people' || share.audience === 'private'));
    const lockedMeta = locked || restricted;
    const metaTitle = locked ? 'A locked paste on OpenVibe Community' : restricted ? 'A paste on OpenVibe Community' : title;
    const metaDescription = locked ? 'A locked paste on OpenVibe Community. Only the people it is locked for can read it.'
        : restricted ? 'A paste shared with specific people on OpenVibe Community.' : description;
    const metaImage = lockedMeta ? undefined : (shot || undefined);
    // Pastes name their owner by Network subject; the projection cache supplies the display fields.
    const isOwner = !!(user && (p.is_owner === true
        || (p.owner_subject && user.subject_id && p.owner_subject === user.subject_id)
        || (p.user_id != null && !p.owner_subject && (String(user.id) === String(p.user_id) || (p.username && user.username === p.username)))));
    const hl = isShot ? null : highlight(p.content, p.language);
    const ext = extensionFor(p.language);
    const isDoc = !!hl && hl.language === 'markdown';

    let bodyBlock;
    if (locked) {
        // The card ov-locker.js draws: a link lock opens with the key after #, a password with its password, a people
        // lock with the reader's own locker. The plaintext is written here, on the device, and nowhere else.
        bodyBlock = `<div id="paste-locked" class="paste-locked" aria-live="polite">
    <p class="muted">Opening on your device…</p>
  </div>`;
    } else if (isShot) {
        bodyBlock = `<figure class="shot${p.is_nsfw ? ' nsfw' : ''}">
    <a href="${esc(shot)}" target="_blank" rel="noopener"><img src="${esc(shot)}" alt="${esc(title)}"></a>
    ${p.content ? `<figcaption>${esc(p.content)}</figcaption>` : ''}
  </figure>`;
    } else {
        const gutter = Array.from({ length: hl.lines }, (_, i) => i + 1).join('\n');
        // It scrolls (long lines, long pastes), so keyboard users must be able to reach and scroll it: a labelled region
        // in the tab order (axe scrollable-region-focusable, the browser check of 2026-10-27 on /p/icy-moon-90).
        const code = `<div class="code-wrap${PROSE.has(hl.language) ? ' wrap' : ''}" data-code tabindex="0" role="region" aria-label="${isDoc ? 'Markdown source' : 'Paste content'}">
    <pre class="gutter" aria-hidden="true">${gutter}</pre>
    <pre class="code"><code class="hljs language-${esc(hl.language)}" id="paste-content">${hl.html}</code></pre>
  </div>`;
        // A Markdown paste is a document: shown formatted (the same safe renderer as forum posts), its source a click
        // away. Copy, Raw and Download still give the source.
        bodyBlock = isDoc ? `<div class="md paste-doc">${renderMarkdown(withoutTitle(p.content, title), { headingShift: 1, document: true })}</div>
  <details class="paste-source">
    <summary><i class="fa-solid fa-code" aria-hidden="true"></i> Markdown source <span class="muted small">${num(hl.lines)} lines</span></summary>
    ${code}
  </details>` : code;
    }

    // The primary action of a locked paste is the card's own (unlock your locker, the password, the link's key): the
    // ordinary actions here are Share, and Delete for its owner. The envelope as a file is a quiet line under the card.
    const actions = locked ? `<div class="actions">
    <button type="button" class="btn btn-sm" data-ov-share-sheet data-title="${esc(title)}" data-kind="paste" data-id="${esc(p.slug)}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> Share</button>
    ${isOwner ? `<button type="button" class="btn btn-sm btn-danger" data-delete="${esc(p.slug)}"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>` : ''}
  </div>` : `<div class="actions">
    ${!isShot ? `<button type="button" class="btn btn-sm btn-primary" data-copy-content="${esc(p.slug)}"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy</button>` : ''}
    ${!isShot ? `<a class="btn btn-sm" href="/p/${esc(pageSlug)}/raw"><i class="fa-solid fa-file-lines" aria-hidden="true"></i> Raw</a>` : `<a class="btn btn-sm" href="/p/${esc(pageSlug)}/screenshot"><i class="fa-solid fa-image" aria-hidden="true"></i> Full image</a>`}
    <a class="btn btn-sm" href="/p/${esc(pageSlug)}/download" download="${esc(pageSlug)}.${esc(isShot ? 'png' : ext)}"><i class="fa-solid fa-download" aria-hidden="true"></i> Download</a>
    ${!isShot ? `<a class="btn btn-sm" href="/new?fork=${esc(p.slug)}"><i class="fa-solid fa-code-fork" aria-hidden="true"></i> Fork</a>` : ''}
    <button type="button" class="btn btn-sm" data-ov-share-sheet data-title="${esc(title)}" data-kind="paste" data-id="${esc(p.slug)}"><i class="fa-solid fa-share-nodes" aria-hidden="true"></i> Share</button>
    ${!restricted && p.visibility === 'public' && !p.burn_after_read ? `<a class="btn btn-sm" href="${esc(comments && comments.thread.forum_url || '#comments')}"><i class="fa-solid fa-comments" aria-hidden="true"></i> Discuss in the forum</a>` : ''}
    ${isOwner ? `<button type="button" class="btn btn-sm btn-danger" data-delete="${esc(p.slug)}"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>` : ''}
  </div>`;

    const offer = share && share.transfer ? `<div id="paste-offer" data-transfer="${esc(share.transfer.id)}" data-username="${esc(p.username || '')}" data-display-name="${esc(p.display_name || '')}" data-expires="${esc(share.transfer.expires_at || '')}" data-keep-access="${share.transfer.keep_access ? '1' : '0'}"></div>` : '';
    const body = `
${offer}
<article class="paste" itemscope itemtype="https://schema.org/${isShot ? 'ImageObject' : 'Article'}">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/pastes">Pastes</a> › <span aria-current="page">${esc(ld.clean(title, 60))}</span></nav>
  <header class="paste-head">
    <h1 itemprop="headline">${p.is_nsfw ? '<span class="badge badge-nsfw">NSFW</span> ' : ''}${esc(title)}</h1>
    <p class="paste-meta">
      ${authorHtml(p)}
      ${locked ? '' : `<span class="sep">·</span>${langBadge(p)}`}
      <span class="sep">·</span><time datetime="${esc(ld.isoDate(p.created_at) || '')}" itemprop="datePublished">${esc(fmtDate(p.created_at))}</time>
      <span class="sep">·</span><span class="stat" title="Views"><i class="fa-solid fa-eye" aria-hidden="true"></i> ${num(p.views)} views</span>
      ${!isShot && !locked && hl ? `<span class="sep">·</span><span class="stat">${num(hl.lines)} lines</span>` : ''}
      ${locked ? `<span class="sep">·</span><span class="badge badge-lock"><i class="fa-solid fa-lock" aria-hidden="true"></i> locked</span>` : ''}
      ${share && share.audience && share.audience !== 'public' ? `<span class="sep">·</span><span class="badge badge-vis"><i class="fa-solid fa-${share.audience === 'private' ? 'lock' : share.audience === 'people' ? 'users' : 'eye-slash'}" aria-hidden="true"></i> ${esc(share.audience === 'link' ? 'anyone with the link' : share.audience === 'people' ? 'specific people' : 'only me')}</span>` : ''}
      ${p.burn_after_read ? `<span class="sep">·</span><span class="badge badge-burn"><i class="fa-solid fa-fire" aria-hidden="true"></i> burns after reading</span>` : ''}
    </p>
    ${p.ai_summary ? `<p class="summary" itemprop="description"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(p.ai_summary)}</p>` : ''}
    ${actions}
  </header>
  ${bodyBlock}
  ${locked ? `<p class="locked-file muted small"><a href="/p/${esc(pageSlug)}/download" download="${esc(pageSlug)}.ovlk"><i class="fa-solid fa-lock" aria-hidden="true"></i> Download the locked file (.ovlk)</a> — it opens only with its key, in the Locker.</p>` : ''}
  <footer class="paste-foot">
    <p class="muted small">Stored by <a href="${esc(config.mediaUrl)}" rel="noopener">OpenVibe.Media</a>, account by <a href="${NETWORK_URL}" rel="noopener">OpenVibe.Network</a>. Something wrong with this paste? <a href="${esc(config.liveUrl)}/dmca">Report it</a>.</p>
  </footer>
</article>
${p.burn_after_read ? '' : `<section class="section">
  ${locked ? '<p class="muted small">Comments are not locked: anyone who can open this paste can read them, and so can OpenVibe.</p>' : ''}
  ${require('./comments').commentPanel({ page: comments, user, base: `/p/${pageSlug}`, action: `/p/${pageSlug}/comments`, sort: commentSort, replyId, expandedId, expandedReplies })}
</section>`}
${!locked && related && related.length ? `<section class="section" id="related">
  <div class="section-head"><h2>More like this</h2><a class="more" href="${!isShot && p.language && p.language !== 'text' ? `/pastes?lang=${encodeURIComponent(p.language)}` : '/pastes'}">Browse <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
  ${cardGrid(related)}
</section>` : ''}
<script src="${ovServe.url('ov-share.js')}" defer></script>${locked ? `
<script>window.OpenVibeLockerConfig = { network: ${JSON.stringify(config.networkUrl)} };</script>
<script src="${ovServe.url('ov-locker.js')}" defer></script>
<script>
window.addEventListener('DOMContentLoaded', function () {
  var box = document.getElementById('paste-locked');
  if (!box || !window.OVLocker) return;
  OVLocker.open(box, { url: ${JSON.stringify(`/p/${pageSlug}/raw`)}, link: location.href, title: ${JSON.stringify(p.title_shown ? title : '')}, onOpen: function (bytes) {
    var text = new TextDecoder().decode(bytes), doc = null;
    try { doc = JSON.parse(text); } catch (e) { doc = null; }
    var shown = doc && typeof doc.content === 'string' ? doc.content : text;
    var named = doc && typeof doc.title === 'string' ? doc.title : '';
    if (named) { var h = document.querySelector('.paste-head h1'); if (h) h.textContent = named; document.title = named + ' — OpenVibe Community'; }
    var wrap = document.createElement('div');
    wrap.className = 'paste-opened';
    var say = document.createElement('p');
    say.className = 'muted small';
    say.textContent = 'Opened on your device. OpenVibe never had the key, so it never saw this.';
    var copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'btn btn-sm btn-primary';
    copy.appendChild(document.createTextNode('Copy'));
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(shown).then(done, function () { copy.textContent = 'Select and copy'; });
      else copy.textContent = 'Select and copy';
    });
    var pre = document.createElement('pre');
    pre.className = 'code paste-plain';
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'The opened paste');
    pre.textContent = shown;
    wrap.appendChild(say); wrap.appendChild(copy); wrap.appendChild(pre);
    box.replaceChildren(wrap);
  } });
});
</script>` : ''}
<script>
window.addEventListener('DOMContentLoaded', function () {
  if (!window.OVShare) return;
  var offer = document.getElementById('paste-offer');
  if (offer && offer.dataset.transfer) {
    OVShare.offer(offer, { kind: 'paste', id: ${JSON.stringify(p.slug)}, transfer_id: offer.dataset.transfer,
      from: { username: offer.dataset.username, display_name: offer.dataset.displayName }, title: ${JSON.stringify(restricted ? '' : title)}, expires_at: offer.dataset.expires || undefined,
      keep_access: offer.dataset.keepAccess === '1' });
  }
});
</script>`;

    return renderPage({
        title: metaTitle,
        description: metaDescription,
        canonicalPath: `/p/${pageSlug}`,
        agentLayer: true,   // the public page has a Markdown twin (server/agent-pages.js)
        // A paste is link-shared content: reached by the link its author shares, not found by
        // search. Google's 2026-10-26 UGC guidance says to noindex those by default; the browse
        // and search pages that are meant to be found keep index. Private, unlisted, NSFW and
        // burn-after-read pastes were already noindex and stay so.
        robots: 'noindex',
        ogType: 'article',
        ogImage: metaImage,
        published: ld.isoDate(p.created_at) || undefined,
        modified: ld.isoDate(p.updated_at) || undefined,
        active: 'pastes',
        historyType: 'paste',
        historyTitle: title,
        footerVariant: 'compact',
        jsonLd: lockedMeta ? [] : [
            ld.pasteLd(p, { description, image: shot || DEFAULT_OG_IMAGE }),
            ld.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }, { name: title, url: `/p/${pageSlug}` }]),
        ],
        styles: ['kit.css', 'thread.css', 'thread-inline.css'],
        body: `${body}<script src="${asset('js/inline-comments.js')}" defer></script>`,
    });
}

// ── New paste ────────────────────────────────────────────────
function newPage({ user, values = {}, error = null, fork = null }) {
    const v = { title: '', language: 'auto', content: '', visibility: 'public', ...values };
    if (fork) { v.title = v.title || `Fork of ${fork.title || 'paste'}`; v.content = v.content || fork.content || ''; v.language = fork.language || v.language; }
    // Signed out, Private and Lock it do not exist; a failed post can still come back asking for one.
    const visibility = !user && v.visibility === 'private' ? 'public' : v.visibility;
    const langOpts = LANGUAGES.map(([id, label]) => `<option value="${id}"${id === v.language ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const visItems = [
        { value: 'public', label: 'Public', icon: 'globe' },
        { value: 'unlisted', label: 'Unlisted', icon: 'link' },
        ...(user ? [{ value: 'private', label: 'Private', icon: 'lock' }] : []),
    ];
    const visMeanings = [
        ['public', 'Listed on Pastes and in search — anyone can find it.'],
        ['unlisted', 'Only people with the link can open it.'],
        ...(user ? [['private', 'Only you can open it.']] : []),
    ];
    const lines = Math.max(12, String(v.content || '').split('\n').length);
    const gutter = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    const whoPic = user ? avatarUrl(user, 72) : null;
    const who = user
        ? `<a class="pf-who" href="/my" title="My pastes">${whoPic ? `<img class="avatar" src="${esc(whoPic)}" alt="" width="28" height="28" loading="lazy">` : ''}<span class="pf-who-text"><small>Posting as</small><strong>${esc(user.display_name || user.username)}</strong></span></a>`
        : `<p class="pf-anon muted small">Posting anonymously. <a href="/auth/login?next=%2Fnew">Sign in</a> to keep your pastes together.</p>`;
    const lock = user ? `<div data-lock-it hidden>
      ${kit.switchRow({ name: 'lock_it', icon: 'lock', title: 'Lock it', line: 'OpenVibe can’t read what’s inside' })}
      <div class="lock-it-body" data-lock-body hidden>
        <p class="muted small">Choose how people open it. Your browser seals the content before it leaves this page; the key never reaches OpenVibe.</p>
        <div class="lock-kinds" role="radiogroup" aria-label="How to lock it">
          <label class="lock-kind"><input type="radio" name="lock_kind" value="people" checked>
            <span><strong>For the people on the list</strong><small>Only you and the people you name can open it, each with their own keys. It switches the audience to Specific people.</small></span></label>
          <label class="lock-kind"><input type="radio" name="lock_kind" value="password">
            <span><strong>With a password</strong><small>Anyone you give the password to can open it. If the password is lost, nobody can open it, including OpenVibe.</small></span></label>
          <label class="lock-kind"><input type="radio" name="lock_kind" value="link">
            <span><strong>With the link</strong><small>The key travels in the link, after the #, which browsers never send to OpenVibe. Anyone with the whole link can open it.</small></span></label>
        </div>
        <div data-lock-for="people">
          <label class="field"><span>People</span>
            <input type="text" name="lock_people" placeholder="@maticus, @quinn" autocomplete="off" spellcheck="false">
          </label>
          <p class="muted small">Their OpenVibe names. Each needs a Locker: they make one the first time they open a locked item.</p>
        </div>
        <label class="field" data-lock-for="password" hidden><span>Password</span>
          <input type="password" name="lock_password" autocomplete="new-password" spellcheck="false">
        </label>
        <label class="check"><input type="checkbox" name="show_title" value="1"> Show the title to people who can open it</label>
        <p class="muted small">Lose the password, or your locker passphrase and recovery kit, and nobody can open this, including OpenVibe. There is no reset.</p>
      </div>
    </div>` : '';
    const body = `
<header class="page-head pf-head">
  <h1>New paste</h1>
  ${who}
</header>
${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
<form class="paste-form" method="post" action="/new" data-new-paste data-lock-network="${esc(config.networkUrl)}"${user ? ` data-subject="${esc(user.subject_id || '')}"` : ''}>
  <div class="tabs pf-modes" role="tablist" aria-label="What to paste">
    <button type="button" class="tab active" data-tab="text" role="tab" aria-selected="true">${kit.icon('code')} Text or code</button>
    <button type="button" class="tab" data-tab="image" role="tab" aria-selected="false" hidden>${kit.icon('image')} Screenshot</button>
  </div>
  <label class="field pf-title"><span>Title</span><input type="text" name="title" maxlength="200" value="${esc(v.title)}" placeholder="Untitled" autocomplete="off"></label>
  <div class="pf-row">
    <label class="field pf-lang"><span>Language</span><select name="language" data-lang-select>${langOpts}</select></label>
    <div class="field pf-vis" data-vis-field>
      <span class="pf-label" id="pf-vis-label">Visibility</span>
      ${kit.segmented({ name: 'visibility', value: visibility, ariaLabel: 'Visibility', items: visItems })}
      <p class="pf-vis-mean" data-vis-meaning>${visMeanings.map(([id, text]) => `<span data-vis-for="${id}">${esc(text)}</span>`).join('')}</p>
    </div>
    ${user ? `<div class="field pf-audience" data-lock-audience hidden><span>Who can open it</span><p class="lock-audience" data-lock-audience-text></p></div>` : ''}
  </div>
  <div data-pane="text" class="pf-pane">
    <div class="codebox" data-codebox>
      <div class="codebox-bar">
        <span class="codebox-drop">Drop a file, or <button type="button" class="pf-file" data-code-file>choose one</button></span>
        <span class="codebox-lang" data-lang-chip>${esc(languageLabel(v.language))}</span>
      </div>
      <div class="codebox-body">
        <div class="codebox-gutter" aria-hidden="true"><div data-gutter>${gutter}</div></div>
        <textarea name="content" rows="12" wrap="off" spellcheck="false" placeholder="Paste it here…" required aria-label="Content">${esc(v.content)}</textarea>
      </div>
      <input type="file" data-code-file-input accept="text/*,image/*,.md,.json,.js,.ts,.jsx,.tsx,.py,.sh,.yml,.yaml,.toml,.ini,.sql,.css,.html,.xml,.diff,.patch,.log,.txt" hidden>
    </div>
  </div>
  <div data-pane="image" hidden>
    <div class="field"><span>Image (PNG, JPEG, WebP or GIF)</span>
      <div data-screenshot-upload></div>
      <p class="form-status" data-screenshot-status role="status" aria-live="polite"></p>
      <div data-screenshot-progress hidden></div>
    </div>
    <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="2000" placeholder="What is this a picture of?"></textarea></label>
  </div>
  <section class="ovk-section pf-options" aria-labelledby="pf-options-h">
    <h2 id="pf-options-h">Options</h2>
    ${kit.switchRow({ name: 'burn_after_read', icon: 'flame', title: 'Burn after reading', line: 'Gone once it is opened', checked: !!v.burn_after_read })}
    ${kit.switchRow({ name: 'is_nsfw', icon: 'eye-off', title: 'Mark as NSFW', line: 'Blurred until it is opened', checked: !!v.is_nsfw })}
    ${lock}
  </section>
  <div class="pf-actions">
    <p class="form-status" data-status aria-live="polite"></p>
    <button class="btn btn-primary pf-create" type="submit">${kit.icon('send')} Create paste</button>
    <p class="pf-rules">By posting you agree to the <a href="${esc(config.liveUrl)}/tos">rules</a>. Say it, own it.</p>
  </div>
</form>`;
    return renderPage({
        title: 'New paste',
        description: 'Create a paste on OpenVibe.Community — code, logs, configs or a screenshot, with a link to share anywhere.',
        canonicalPath: '/new',
        robots: 'noindex,follow',
        active: 'new',
        footerVariant: 'compact',
        styles: ['kit.css', 'ov-upload.css'],   // the options card, the switch rows and the shared picker
        scripts: ['ov-upload.js'],
        body,
    });
}

// ── My pastes ────────────────────────────────────────────────
function myPage({ user, pastes, total, error }) {
    const body = `
<header class="page-head">
  <h1>My pastes</h1>
  <p class="muted">${esc(user.display_name || user.username)} · ${num(total || (pastes || []).length)} ${total === 1 ? 'paste' : 'pastes'} · <a href="/new">new paste</a> · <a href="${NETWORK_URL}/my" rel="noopener">account</a></p>
</header>
${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
<section data-results>
  ${cardGrid(pastes, 'You have not posted anything yet. Your public, unlisted and private pastes all show up here.')}
</section>`;
    return renderPage({
        title: 'My pastes',
        description: 'Your pastes on OpenVibe.Community.',
        canonicalPath: '/my',
        robots: 'noindex,nofollow',
        active: 'my',
        footerVariant: 'compact',
        body,
    });
}

// ── Errors ───────────────────────────────────────────────────
/**
 * The page a person who is not on the list sees (design 2026-11-06): it never shows the title, the
 * content, the screenshot or the comments. OVShare.gate offers "Ask for access" to somebody signed
 * in and "Sign in" to everybody else; the plain fallback below is removed by the script.
 */
function gatePage({ slug, signedInAs = null, signInUrl = '/auth/login' }) {
    const body = `<header class="page-head">
  <h1>A paste on OpenVibe Community</h1>
  <p class="muted">This is shared with specific people.</p>
</header>
<div id="paste-gate">
  <p class="muted">This paste is shared with specific people on OpenVibe Community.</p>
  <p><a class="btn btn-sm" href="${esc(signInUrl)}">Sign in</a></p>
</div>
<script src="${ovServe.url('ov-share.js')}" defer></script>
<script>
window.addEventListener('DOMContentLoaded', function () {
  var el = document.getElementById('paste-gate');
  if (el && window.OVShare) OVShare.gate(el, { kind: 'paste', id: ${JSON.stringify(slug)},
    signedInAs: ${JSON.stringify(signedInAs || '')}, signInUrl: ${JSON.stringify(signInUrl)} });
});
</script>`;
    return renderPage({
        title: 'A paste on OpenVibe Community',
        description: 'A paste shared with specific people on OpenVibe Community.',
        canonicalPath: `/p/${encodeURIComponent(slug)}`,
        robots: 'noindex,nofollow',
        active: 'pastes',
        footerVariant: 'compact',
        body,
    });
}

function errorPage({ status = 500, title = 'Something went wrong', message = '', links = true }) {
    const body = `
<section class="error">
  <p class="eyebrow">${status}</p>
  <h1>${esc(title)}</h1>
  ${message ? `<p class="lede">${esc(message)}</p>` : ''}
  ${links ? `<p><a class="btn" href="/">Home</a> <a class="btn" href="/pastes">Browse pastes</a> <a class="btn btn-primary" href="/new">New paste</a></p>` : ''}
</section>`;
    return renderPage({ title, description: message || title, canonicalPath: '/', robots: 'noindex,nofollow', footerVariant: 'compact', body });
}

module.exports = { homePage, updatesPage, browsePage, pastePage, gatePage, newPage, myPage, errorPage, pasteCard, cardGrid, timeAgo, timeTag, fmtDate, num, authorHtml, avatarUrl, mediaW, wearName };
