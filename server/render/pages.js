'use strict';

/**
 * Page templates. Plain template strings, every user value escaped, no framework. The markup
 * is the whole page for crawlers and no-JS readers; public/js/community.js only adds the
 * comforts (copy, in-place pagination, the create form's upload path).
 */
const config = require('../config');
const live = require('../live-client');
const seo = require('../seo');
const { renderPage, SITE_NAME, DEFAULT_OG_IMAGE } = require('./layout');
const frame = require('openvibe-shared/frame');
const { highlight, escapeHtml: esc, languageLabel, extensionFor, LANGUAGES } = require('./highlight');

const NETWORK_URL = 'https://openvibe.network';

// ── Small helpers ────────────────────────────────────────────
function timeAgo(v) {
    const iso = seo.isoDate(v);
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
    const iso = seo.isoDate(v);
    if (!iso) return '';
    return new Date(iso).toUTCString().replace(/:\d\d GMT$/, ' UTC');
}
function timeTag(v) {
    const iso = seo.isoDate(v);
    return iso ? `<time datetime="${esc(iso)}" title="${esc(fmtDate(v))}">${esc(timeAgo(v))}</time>` : '';
}
function num(n) { return Number(n || 0).toLocaleString('en-US'); }
function authorName(p) { return p.display_name || p.username || 'Anonymous'; }
function authorHtml(p, { link = true } = {}) {
    const name = authorName(p);
    const initial = esc(name.trim()[0] || '?').toUpperCase();
    const avatarSrc = p.avatar_url ? (/^https?:\/\//i.test(p.avatar_url) ? p.avatar_url : `${config.liveUrl}${p.avatar_url.startsWith('/') ? '' : '/'}${p.avatar_url}`) : null;
    // No picture on the paste's own record: the network's avatar address answers for any account (the person's
    // picture, or a generated initial), so an author looks the same here as on every other OpenVibe site.
    const netAvatar = !avatarSrc && p.username ? `${config.networkUrl}/avatar/${encodeURIComponent(p.username)}?s=44` : null;
    const avatar = (avatarSrc || netAvatar)
        ? `<img class="avatar" src="${esc(avatarSrc || netAvatar)}" alt="" loading="lazy" width="22" height="22">`
        : `<span class="avatar avatar-letter" aria-hidden="true">${initial}</span>`;
    const inner = `${avatar}<span>${esc(name)}</span>`;
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
    if (page > 1) q.set('page', String(page));
    const s = q.toString();
    return `/pastes${s ? `?${s}` : ''}`;
}

// ── Paste card (grid item) ───────────────────────────────────
function pasteCard(p) {
    const isShot = p.type === 'screenshot';
    const preview = isShot
        ? (p.screenshot_url ? `<div class="card-shot"><img src="${esc(live.mediaPublicUrl(p.screenshot_url))}" alt="${esc(p.title || 'Screenshot')}" loading="lazy"></div>` : '')
        : `<pre class="card-code" aria-hidden="true">${esc(String(p.content || '').slice(0, 220))}${String(p.content || '').length > 220 ? '…' : ''}</pre>`;
    const flags = `${p.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned"></i> ' : ''}${p.burn_after_read ? '<i class="fa-solid fa-fire" title="Burns after reading"></i> ' : ''}${p.is_nsfw ? '<span class="badge badge-nsfw">NSFW</span> ' : ''}`;
    return `<article class="card${p.is_nsfw ? ' card-nsfw' : ''}">
  <a class="card-link" href="/p/${esc(p.slug)}">
    ${preview}
    <h3 class="card-title">${flags}${esc(p.title || 'Untitled')}</h3>
  </a>
  <div class="card-meta">
    ${authorHtml(p)}
    <span class="card-right">${langBadge(p)}<span class="stat" title="Views"><i class="fa-solid fa-eye" aria-hidden="true"></i> ${num(p.views)}</span>${timeTag(p.created_at)}</span>
  </div>
</article>`;
}
function cardGrid(pastes, empty = 'Nothing here yet.') {
    if (!pastes || !pastes.length) return `<p class="empty">${esc(empty)}</p>`;
    return `<div class="grid">${pastes.map(pasteCard).join('\n')}</div>`;
}

// ── Home ─────────────────────────────────────────────────────
function homePage({ latest, trending, languages, user }) {
    const body = `
<section class="hero">
  <p class="eyebrow">OpenVibe.Community</p>
  <h1>Share it with a link. Talk about it here.</h1>
  <p class="lede">Paste code, logs, configs or a screenshot and get a short link that works anywhere. Reading and sharing need no account. Sign in with your OpenVibe account to edit, comment and keep a list of your own, and talk things through in <a href="/s">Spaces</a>.</p>
  <div class="hero-actions">
    <a class="btn btn-primary" href="/new"><i class="fa-solid fa-plus" aria-hidden="true"></i> Start a paste</a>
    <a class="btn" href="/pastes"><i class="fa-solid fa-paste" aria-hidden="true"></i> Browse pastes</a>
    <a class="btn" href="/s"><i class="fa-solid fa-comments" aria-hidden="true"></i> Spaces</a>
    ${user ? `<a class="btn btn-ghost" href="/my"><i class="fa-solid fa-user" aria-hidden="true"></i> My pastes</a>` : `<a class="btn btn-ghost" href="/auth/login?next=%2F"><i class="fa-solid fa-right-to-bracket" aria-hidden="true"></i> Sign in with your OpenVibe account</a>`}
  </div>
  <ul class="hero-points">
    <li><i class="fa-solid fa-people-group" aria-hidden="true"></i> Run by the people using it, moderated in the open</li>
    <li><i class="fa-solid fa-comment" aria-hidden="true"></i> Open expression within the rules: say it, own it</li>
    <li><i class="fa-brands fa-github" aria-hidden="true"></i> Open source — <a href="https://github.com/OpenVibers/OpenVibe.Community" rel="noopener">read the code</a></li>
  </ul>
</section>

<section class="section" id="latest">
  <div class="section-head"><h2>Latest pastes</h2><a class="more" href="/pastes">All pastes <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
  ${cardGrid(latest, 'No pastes yet — be the first.')}
</section>

<section class="section" id="trending">
  <div class="section-head"><h2>Most viewed</h2><a class="more" href="/pastes?sort=views">By views <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
  ${cardGrid(trending, 'Nothing trending yet.')}
</section>

<section class="section cta" id="start">
  <div class="cta-inner">
    <h2>Start a paste</h2>
    <p>Code, logs, configs, a screenshot — paste it, get a link, share it anywhere. Sign in to keep your pastes together under your OpenVibe account, or post anonymously.</p>
    <a class="btn btn-primary" href="/new"><i class="fa-solid fa-plus" aria-hidden="true"></i> New paste</a>
    ${languages && languages.length ? `<p class="lang-cloud">${languages.slice(0, 12).map((l) => `<a href="/pastes?lang=${encodeURIComponent(l.language)}">${esc(languageLabel(l.language))} <small>${l.count}</small></a>`).join(' ')}</p>` : ''}
  </div>
</section>

<section class="section coming" id="spaces">
  <h2>Spaces and threads</h2>
  <div class="coming-grid">
    <div class="coming-item"><i class="fa-solid fa-layer-group" aria-hidden="true"></i><h3><a href="/s">Spaces</a></h3><p>General, Feedback and Showcase: places for the community to talk, share and get help.</p></div>
    <div class="coming-item"><i class="fa-solid fa-comments" aria-hidden="true"></i><h3><a href="/s/general">Threads</a></h3><p>Long-form discussion that outlives a chat scrollback: start one in any open space.</p></div>
    <div class="coming-item"><i class="fa-solid fa-wave-square" aria-hidden="true"></i><h3><a href="/pulse">Pulse</a></h3><p>What is happening across the OpenVibe network, in one feed.</p></div>
  </div>
</section>
<section class="section">${frame.shipped({ service: 'community', title: 'Recently shipped on OpenVibe.Community' })}</section>`;
    return renderPage({
        title: null,
        description: 'The people of OpenVibe. A community-run, open source home for pastes — code, logs and screenshots with a link — spaces and threads, and soon submissions. Free speech within the rules.',
        canonicalPath: '/',
        active: 'home',
        jsonLd: [seo.websiteLd()],
        body,
    });
}

// ── What shipped: the shared update log every OpenVibe site has ──
function updatesPage() {
    return renderPage({
        title: 'What shipped on OpenVibe.Community',
        description: 'Every change deployed to OpenVibe.Community, newest first, with the Patch notes that gather them.',
        canonicalPath: '/updates',
        body: frame.updatesBody({ service: 'community', siteName: 'OpenVibe.Community' }) + frame.shippedScript(),
    });
}

// ── Browse ───────────────────────────────────────────────────
function browsePage(result, languages) {
    const { pastes, total, page, pages, q, sort, lang, type = 'pastes', windowed, windowSize } = result;
    const titleBits = [];
    if (q) titleBits.push(`“${q}”`);
    if (lang) titleBits.push(languageLabel(lang));
    titleBits.push(sort === 'views' ? 'most viewed' : 'newest');
    const title = `Pastes — ${titleBits.join(', ')}${page > 1 ? ` (page ${page})` : ''}`;
    const canonical = pagerHref({ q, sort, lang, type }, page);
    const opt = (id, label) => `<option value="${esc(id)}"${id === (lang || '') ? ' selected' : ''}>${esc(label)}</option>`;
    const langOptions = [opt('', 'All languages')].concat((languages || []).map((l) => opt(l.language, `${languageLabel(l.language)} (${l.count})`)));
    if (lang && !(languages || []).some((l) => l.language === lang)) langOptions.push(opt(lang, languageLabel(lang)));

    const pager = pages > 1 ? `<nav class="pager" aria-label="Pages">
    ${page > 1 ? `<a rel="prev" href="${esc(pagerHref({ q, sort, lang, type }, page - 1))}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> Newer</a>` : '<span></span>'}
    <span class="pager-info">Page ${page} of ${pages}</span>
    ${page < pages ? `<a rel="next" href="${esc(pagerHref({ q, sort, lang, type }, page + 1))}">Older <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a>` : '<span></span>'}
  </nav>` : '';

    const body = `
<header class="page-head">
  <h1>Pastes</h1>
  <p class="muted">${num(total)} ${total === 1 ? 'paste' : 'pastes'}${windowed ? ` in the latest ${windowSize}` : ''}${q ? ` matching “${esc(q)}”` : ''}</p>
</header>
<form class="filters" method="get" action="/pastes" role="search" data-browse>
  <label class="search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" name="q" value="${esc(q)}" placeholder="Search titles and content" aria-label="Search pastes"></label>
  <label>Show <select name="type"><option value="pastes"${type === 'pastes' ? ' selected' : ''}>Pastes</option><option value="images"${type === 'images' ? ' selected' : ''}>Images</option><option value="all"${type === 'all' ? ' selected' : ''}>All</option></select></label>
  <label>Sort <select name="sort"><option value="new"${sort === 'new' ? ' selected' : ''}>Newest</option><option value="views"${sort === 'views' ? ' selected' : ''}>Most viewed</option></select></label>
  <label>Language <select name="lang">${langOptions.join('')}</select></label>
  <button class="btn" type="submit">Apply</button>
  ${(q || lang || sort !== 'new') ? `<a class="btn btn-ghost" href="/pastes">Clear</a>` : ''}
</form>
<section id="results" data-results>
  ${cardGrid(pastes, q ? 'No pastes match that search.' : 'No pastes yet.')}
  ${pager}
</section>`;
    return renderPage({
        title,
        description: `Browse ${sort === 'views' ? 'the most viewed' : 'the latest'} pastes on OpenVibe.Community${lang ? ` in ${languageLabel(lang)}` : ''} — code, logs and screenshots shared by the people of OpenVibe.`,
        canonicalPath: canonical,
        robots: q ? 'noindex,follow' : 'index,follow',
        active: 'pastes',
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }])],
        body,
    });
}

// ── Paste page ───────────────────────────────────────────────
function pasteDescription(p) {
    if (p.ai_summary) return seo.clean(p.ai_summary, 200);
    if (p.type === 'screenshot') return seo.clean(p.content || `A screenshot shared by ${authorName(p)} on ${SITE_NAME}.`, 200);
    return seo.clean(`${p.title || 'Paste'} — ${languageLabel(p.language)} paste by ${authorName(p)}: ${String(p.content || '').slice(0, 200)}`, 200);
}

function shareLinks(p) {
    const url = `${config.baseUrl}/p/${p.slug}`;
    const text = `${p.title || 'A paste'} — ${SITE_NAME}`;
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    return `<div class="share" aria-label="Share">
    <button type="button" class="btn btn-sm" data-copy-link="${esc(url)}"><i class="fa-solid fa-link" aria-hidden="true"></i> Copy link</button>
    <a class="btn btn-sm" href="https://twitter.com/intent/tweet?url=${u}&text=${t}" target="_blank" rel="noopener"><i class="fa-brands fa-x-twitter" aria-hidden="true"></i> X</a>
    <a class="btn btn-sm" href="https://bsky.app/intent/compose?text=${t}%20${u}" target="_blank" rel="noopener"><i class="fa-brands fa-bluesky" aria-hidden="true"></i> Bluesky</a>
    <a class="btn btn-sm" href="https://www.reddit.com/submit?url=${u}&title=${t}" target="_blank" rel="noopener"><i class="fa-brands fa-reddit-alien" aria-hidden="true"></i> Reddit</a>
    <a class="btn btn-sm" href="mailto:?subject=${t}&body=${u}"><i class="fa-solid fa-envelope" aria-hidden="true"></i> Email</a>
  </div>`;
}

function pastePage({ paste: p, related, user }) {
    const isShot = p.type === 'screenshot';
    const title = p.title || (isShot ? 'Screenshot' : 'Untitled paste');
    const description = pasteDescription(p);
    const shot = isShot ? live.mediaPublicUrl(p.screenshot_url) || live.screenshotUrl(p.slug) : null;
    const indexable = (p.visibility === 'public' || p.visibility == null) && !Number(p.is_nsfw) && !Number(p.burn_after_read);
    // Community-authority pastes name their owner by Network subject; Live-proxied ones by name.
    const isOwner = !!(user && (p.is_owner === true
        || (p.owner_subject && user.subject_id && p.owner_subject === user.subject_id)
        || (p.user_id != null && !p.owner_subject && (String(user.id) === String(p.user_id) || (p.username && user.username === p.username)))));
    const hl = isShot ? null : highlight(p.content, p.language);
    const ext = extensionFor(p.language);

    let bodyBlock;
    if (isShot) {
        bodyBlock = `<figure class="shot${p.is_nsfw ? ' nsfw' : ''}">
    <a href="${esc(shot)}" target="_blank" rel="noopener"><img src="${esc(shot)}" alt="${esc(title)}"></a>
    ${p.content ? `<figcaption>${esc(p.content)}</figcaption>` : ''}
  </figure>`;
    } else {
        const gutter = Array.from({ length: hl.lines }, (_, i) => i + 1).join('\n');
        bodyBlock = `<div class="code-wrap" data-code>
    <pre class="gutter" aria-hidden="true">${gutter}</pre>
    <pre class="code"><code class="hljs language-${esc(hl.language)}" id="paste-content">${hl.html}</code></pre>
  </div>`;
    }

    const actions = `<div class="actions">
    ${!isShot ? `<button type="button" class="btn btn-sm btn-primary" data-copy-content="${esc(p.slug)}"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy</button>` : ''}
    ${!isShot ? `<a class="btn btn-sm" href="/p/${esc(p.slug)}/raw"><i class="fa-solid fa-file-lines" aria-hidden="true"></i> Raw</a>` : `<a class="btn btn-sm" href="/p/${esc(p.slug)}/screenshot"><i class="fa-solid fa-image" aria-hidden="true"></i> Full image</a>`}
    <a class="btn btn-sm" href="/p/${esc(p.slug)}/download" download="${esc(p.slug)}.${esc(isShot ? 'png' : ext)}"><i class="fa-solid fa-download" aria-hidden="true"></i> Download</a>
    ${!isShot ? `<a class="btn btn-sm" href="/new?fork=${esc(p.slug)}"><i class="fa-solid fa-code-fork" aria-hidden="true"></i> Fork</a>` : ''}
    ${isOwner ? `<button type="button" class="btn btn-sm btn-danger" data-delete="${esc(p.slug)}"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete</button>` : ''}
  </div>`;

    const body = `
<article class="paste" itemscope itemtype="https://schema.org/${isShot ? 'ImageObject' : 'Article'}">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/pastes">Pastes</a> › <span aria-current="page">${esc(seo.clean(title, 60))}</span></nav>
  <header class="paste-head">
    <h1 itemprop="headline">${p.is_nsfw ? '<span class="badge badge-nsfw">NSFW</span> ' : ''}${esc(title)}</h1>
    <p class="paste-meta">
      ${authorHtml(p)}
      <span class="sep">·</span>${langBadge(p)}
      <span class="sep">·</span><time datetime="${esc(seo.isoDate(p.created_at) || '')}" itemprop="datePublished">${esc(fmtDate(p.created_at))}</time>
      <span class="sep">·</span><span class="stat" title="Views"><i class="fa-solid fa-eye" aria-hidden="true"></i> ${num(p.views)} views</span>
      ${!isShot && hl ? `<span class="sep">·</span><span class="stat">${num(hl.lines)} lines</span>` : ''}
      ${p.visibility && p.visibility !== 'public' ? `<span class="sep">·</span><span class="badge badge-vis"><i class="fa-solid fa-${p.visibility === 'private' ? 'lock' : 'eye-slash'}" aria-hidden="true"></i> ${esc(p.visibility)}</span>` : ''}
      ${p.burn_after_read ? `<span class="sep">·</span><span class="badge badge-burn"><i class="fa-solid fa-fire" aria-hidden="true"></i> burns after reading</span>` : ''}
    </p>
    ${p.ai_summary ? `<p class="summary" itemprop="description"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> ${esc(p.ai_summary)}</p>` : ''}
    ${actions}
  </header>
  ${bodyBlock}
  <footer class="paste-foot">
    ${shareLinks(p)}
    <p class="muted small">Stored by <a href="${esc(config.mediaUrl)}" rel="noopener">OpenVibe.Media</a>, account by <a href="${NETWORK_URL}" rel="noopener">OpenVibe.Network</a>. Something wrong with this paste? <a href="${esc(config.liveUrl)}/dmca">Report it</a>.</p>
  </footer>
</article>
${related && related.length ? `<section class="section" id="related">
  <div class="section-head"><h2>More like this</h2><a class="more" href="${!isShot && p.language && p.language !== 'text' ? `/pastes?lang=${encodeURIComponent(p.language)}` : '/pastes'}">Browse <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></a></div>
  ${cardGrid(related)}
</section>` : ''}`;

    return renderPage({
        title,
        description,
        canonicalPath: `/p/${p.slug}`,
        robots: indexable ? 'index,follow' : 'noindex,follow',
        ogType: 'article',
        ogImage: shot || undefined,
        published: seo.isoDate(p.created_at) || undefined,
        modified: seo.isoDate(p.updated_at) || undefined,
        active: 'pastes',
        historyType: 'paste',
        historyTitle: title,
        footerVariant: 'compact',
        jsonLd: [
            seo.pasteLd(p, { description, image: shot || DEFAULT_OG_IMAGE }),
            seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Pastes', url: '/pastes' }, { name: title, url: `/p/${p.slug}` }]),
        ],
        body,
    });
}

// ── New paste ────────────────────────────────────────────────
function newPage({ user, values = {}, error = null, fork = null }) {
    const v = { title: '', language: 'auto', content: '', visibility: 'public', ...values };
    if (fork) { v.title = v.title || `Fork of ${fork.title || 'paste'}`; v.content = v.content || fork.content || ''; v.language = fork.language || v.language; }
    const langOpts = LANGUAGES.map(([id, label]) => `<option value="${id}"${id === v.language ? ' selected' : ''}>${esc(label)}</option>`).join('');
    const body = `
<header class="page-head">
  <h1>New paste</h1>
  <p class="muted">${user ? `Posting as <strong>${esc(user.display_name || user.username)}</strong> — your pastes collect under <a href="/my">My pastes</a>.` : `Posting anonymously. <a href="/auth/login?next=%2Fnew">Sign in</a> to keep your pastes together and delete them later.`}</p>
</header>
${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
<form class="paste-form" method="post" action="/new" data-new-paste>
  <div class="tabs" role="tablist">
    <button type="button" class="tab active" data-tab="text" role="tab" aria-selected="true"><i class="fa-solid fa-code" aria-hidden="true"></i> Text or code</button>
    <button type="button" class="tab" data-tab="image" role="tab" aria-selected="false" hidden><i class="fa-solid fa-image" aria-hidden="true"></i> Screenshot</button>
  </div>
  <label class="field"><span>Title</span><input type="text" name="title" maxlength="200" value="${esc(v.title)}" placeholder="Untitled"></label>
  <div class="field-row">
    <label class="field"><span>Language</span><select name="language">${langOpts}</select></label>
    <label class="field"><span>Visibility</span><select name="visibility">
      <option value="public"${v.visibility === 'public' ? ' selected' : ''}>Public — listed and searchable</option>
      <option value="unlisted"${v.visibility === 'unlisted' ? ' selected' : ''}>Unlisted — link only</option>
      ${user ? `<option value="private"${v.visibility === 'private' ? ' selected' : ''}>Private — only you</option>` : ''}
    </select></label>
  </div>
  <div data-pane="text">
    <label class="field"><span>Content</span><textarea name="content" rows="18" spellcheck="false" placeholder="Paste it here…" required>${esc(v.content)}</textarea></label>
  </div>
  <div data-pane="image" hidden>
    <label class="field"><span>Image (PNG, JPEG, WebP or GIF)</span><input type="file" name="screenshot" accept="image/png,image/jpeg,image/webp,image/gif" disabled></label>
    <label class="field"><span>Description</span><textarea name="description" rows="3" maxlength="2000" placeholder="What is this a picture of?"></textarea></label>
  </div>
  <div class="field-row options">
    <label class="check"><input type="checkbox" name="burn_after_read" value="1"${v.burn_after_read ? ' checked' : ''}> Burn after reading</label>
    <label class="check"><input type="checkbox" name="is_nsfw" value="1"${v.is_nsfw ? ' checked' : ''}> Mark as NSFW</label>
  </div>
  <div class="form-actions">
    <button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Create paste</button>
    <span class="muted small">By posting you agree to the <a href="${esc(config.liveUrl)}/tos">rules</a>. Say it, own it.</span>
  </div>
  <p class="form-status" data-status aria-live="polite"></p>
</form>`;
    return renderPage({
        title: 'New paste',
        description: 'Create a paste on OpenVibe.Community — code, logs, configs or a screenshot, with a link to share anywhere.',
        canonicalPath: '/new',
        robots: 'noindex,follow',
        active: 'new',
        footerVariant: 'compact',
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

module.exports = { homePage, updatesPage, browsePage, pastePage, newPage, myPage, errorPage, pasteCard, cardGrid, timeAgo, timeTag, fmtDate, num, authorHtml };
