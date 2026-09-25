'use strict';

/**
 * Forum pages — /s (spaces), /s/:space (threads), /s/:space/t/:slug (a thread), /s/:space/new.
 * Complete without JavaScript: sorting and pagination are links, replying, voting and the
 * moderator buttons are plain form posts. Every user value is escaped; post bodies are the safe
 * Markdown renderer's output (render/markdown.js).
 */
const seo = require('../seo');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { markdownToText } = require('./markdown');
const { timeTag, fmtDate, num, authorHtml } = require('./pages');

const SORT_LABELS = { hot: 'Hot', new: 'New', top: 'Top' };
const STATUS_LABELS = { open: 'Open', planned: 'Planned', in_progress: 'In progress', done: 'Done', declined: 'Declined', paused: 'Paused' };
/** A request's or roadmap item's status, and a thread's category. */
const statusBadge = (t) => (t && t.status ? ` <span class="badge badge-status status-${esc(t.status)}">${esc(STATUS_LABELS[t.status] || t.status)}</span>` : '');
const categoryBadge = (t, space) => (t && t.category ? ` <a class="badge badge-category" href="${esc(spaceHref(space.slug, { category: t.category.slug }))}">${esc(t.category.name)}</a>` : '');
const VIS_LABELS = { members: 'Members only', staff: 'Staff only' };

function who(a) {
    if (!a) return '<span class="author"><span class="avatar avatar-letter" aria-hidden="true">?</span><span>Anonymous</span></span>';
    if (a.is_ai) return `<span class="author">${authorHtml({ display_name: a.display_name }, { link: false })}</span> <span class="badge badge-ai" title="Written by AI, not by a person">AI</span>`;
    if (a.is_system) return `<span class="author">${authorHtml({ display_name: a.display_name }, { link: false })}</span>`;
    return authorHtml(a);
}

function spaceHref(slug, { sort = 'hot', page = 1, category = null, status = null } = {}) {
    const q = new URLSearchParams();
    if (category) q.set('category', category);
    if (status) q.set('status', status);
    if (sort && sort !== 'hot') q.set('sort', sort);
    if (page > 1) q.set('page', String(page));
    const s = q.toString();
    return `/s/${encodeURIComponent(slug)}${s ? `?${s}` : ''}`;
}

function pager(href, page, pages, labels = ['Newer', 'Older']) {
    if (pages <= 1) return '';
    return `<nav class="pager" aria-label="Pages">
    ${page > 1 ? `<a rel="prev" href="${esc(href(page - 1))}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> ${labels[0]}</a>` : '<span></span>'}
    <span class="pager-info">Page ${page} of ${pages}</span>
    ${page < pages ? `<a rel="next" href="${esc(href(page + 1))}">${labels[1]} <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a>` : '<span></span>'}
  </nav>`;
}

const visBadge = (s) => (VIS_LABELS[s.visibility] ? ` <span class="badge badge-vis"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${esc(VIS_LABELS[s.visibility])}</span>` : '') + vipBadge(s);
/** A members-only (OpenVibe.VIP) space or thread. */
const vipBadge = (x) => (x && x.members_only ? ` <span class="badge badge-vis badge-vip" title="For this creator's OpenVibe.VIP members"><i class="fa-solid fa-star" aria-hidden="true"></i> VIP members only</span>` : '');
const vipJoin = (mo, label = 'Join on OpenVibe.VIP') => (mo && mo.join_url ? `<a class="btn btn-primary" href="${esc(mo.join_url)}" rel="noopener">${esc(label)}</a>` : '');

// ── /s ───────────────────────────────────────────────────────
function spacesPage({ spaces }) {
    const list = spaces.length ? `<ul class="space-list">${spaces.map((s) => `
    <li class="space-item">
      <a class="space-link" href="/s/${esc(s.slug)}"><h2>${esc(s.name)}${visBadge(s)}</h2></a>
      ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ''}
      <p class="small muted">${num(s.thread_count)} ${s.thread_count === 1 ? 'thread' : 'threads'}${s.last_activity_at ? ` · last activity ${timeTag(s.last_activity_at)}` : ''}</p>
    </li>`).join('')}
  </ul>` : '<p class="empty">No spaces yet.</p>';
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Spaces</span></nav>
  <h1>Spaces</h1>
  <p class="muted">Long-form discussion for the people of OpenVibe. Read without an account; sign in to start a thread or reply. See what is happening across the network on <a href="/pulse">Pulse</a>.</p>
</header>
${list}`;
    return renderPage({
        title: 'Spaces',
        description: 'Spaces on OpenVibe.Community: general talk, feedback and feature requests, and a showcase of what the people of OpenVibe make.',
        canonicalPath: '/s',
        active: 'spaces',
        feeds: [{ title: 'OpenVibe.Community — latest threads', href: '/s/feed.xml' }],
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Spaces', url: '/s' }])],
        body,
    });
}

// ── /s/:space ────────────────────────────────────────────────
function threadRow(t, space) {
    const flags = `${t.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned" aria-label="Pinned"></i> ' : ''}${t.locked ? '<i class="fa-solid fa-lock" title="Locked" aria-label="Locked"></i> ' : ''}`;
    return `<li class="thread-row">
    <span class="thread-score" title="Score">${num(t.score)}</span>
    <div class="thread-main">
      <a class="thread-title" href="/s/${esc(space.slug)}/t/${esc(t.slug)}">${flags}${esc(t.title)}</a>${statusBadge(t)}${categoryBadge(t, space)}${vipBadge(t)}
      <p class="thread-meta">${who(t.author)} <span class="sep">·</span> ${timeTag(t.created_at)} <span class="sep">·</span> <span class="stat"><i class="fa-solid fa-comment" aria-hidden="true"></i> ${num(t.reply_count)} ${t.reply_count === 1 ? 'reply' : 'replies'}</span>${t.reply_count ? ` <span class="sep">·</span> active ${timeTag(t.last_activity_at)}` : ''}</p>
    </div>
  </li>`;
}

function spacePage({ space, threads, sort, page, pages, total, user, categories = [], category = null, status = null, viewer = {} }) {
    const tabs = Object.keys(SORT_LABELS).map((s) => `<a class="tab${s === sort ? ' active' : ''}" href="${esc(spaceHref(space.slug, { sort: s, category, status }))}"${s === sort ? ' aria-current="page"' : ''}>${SORT_LABELS[s]}</a>`).join('');
    const filtered = !!(category || status);
    const indexable = space.visibility === 'public' && !space.members_only && !filtered;
    const chip = (label, href, on) => `<a class="chip${on ? ' active' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''}>${label}</a>`;
    const categoryNav = categories.length ? `<nav class="chips" aria-label="Categories">${chip('All', spaceHref(space.slug, { sort, status }), !category)}${categories.map((c) => chip(`${esc(c.name)} <span class="muted">${num(c.thread_count || 0)}</span>`, spaceHref(space.slug, { sort, status, category: c.slug }), c.slug === category)).join('')}</nav>` : '';
    const statusNav = (space.statuses || []).length ? `<nav class="chips" aria-label="Status">${chip('Any status', spaceHref(space.slug, { sort, category }), !status)}${space.statuses.map((st) => chip(esc(STATUS_LABELS[st] || st), spaceHref(space.slug, { sort, category, status: st }), st === status)).join('')}</nav>` : '';
    const canStart = viewer.can_start !== false;
    const startLabel = space.thread_kind === 'request' ? 'New request' : space.thread_kind === 'roadmap' ? 'New roadmap item' : 'New thread';
    const start = canStart ? `<p><a class="btn btn-primary" href="/s/${esc(space.slug)}/new"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${startLabel}</a>${user ? '' : ' <span class="muted small">Sign in with your OpenVibe account to post.</span>'}</p>`
        : `<p class="muted small">Staff add roadmap items. Open one to ask about it or argue for it, or suggest something new in <a href="/s/feedback">Feedback</a>.</p>`;
    const categoryName = category ? (categories.find((c) => c.slug === category) || {}).name : null;
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/s">Spaces</a> › <span aria-current="page">${esc(space.name)}</span></nav>
  <h1>${esc(space.name)}${visBadge(space)}</h1>
  ${space.description ? `<p class="muted">${esc(space.description)}</p>` : ''}
  ${start}
</header>
${categoryNav}${statusNav}
<nav class="tabs sort-tabs" aria-label="Sort threads">${tabs}</nav>
<section data-results>
  ${threads.length ? `<ol class="thread-list">${threads.map((t) => threadRow(t, space)).join('')}</ol>` : filtered ? `<p class="empty">Nothing here yet. <a href="${esc(spaceHref(space.slug))}">See everything in ${esc(space.name)}</a>.</p>` : canStart ? `<p class="empty">No threads yet — <a href="/s/${esc(space.slug)}/new">start the first one</a>.</p>` : '<p class="empty">Nothing here yet.</p>'}
  ${pager((n) => spaceHref(space.slug, { sort, page: n, category, status }), page, pages)}
</section>`;
    return renderPage({
        title: `${space.name}${categoryName ? ` · ${categoryName}` : ''}${status ? ` · ${STATUS_LABELS[status] || status}` : ''} — ${SORT_LABELS[sort].toLowerCase()} threads${page > 1 ? ` (page ${page})` : ''}`,
        description: `${space.description || `Threads in ${space.name}`} ${num(total)} ${total === 1 ? 'thread' : 'threads'} on OpenVibe.Community.`,
        canonicalPath: spaceHref(space.slug, { sort, page, category, status }),
        robots: indexable ? 'index,follow' : filtered && space.visibility === 'public' && !space.members_only ? 'noindex,follow' : 'noindex,nofollow',
        active: 'spaces',
        feeds: indexable ? [{ title: `OpenVibe.Community — ${space.name}`, href: `/s/${space.slug}/feed.xml` }] : [],
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Spaces', url: '/s' }, { name: space.name, url: `/s/${space.slug}` }])],
        body,
    });
}

// ── /s/:space/t/:slug ────────────────────────────────────────
function postHtml(p, n) {
    if (p.deleted) return `<article class="post post-deleted" id="post-${p.id}"><p class="muted small">#${n} · This post was deleted.</p></article>`;
    return `<article class="post${p.is_opening ? ' post-opening' : ''}" id="post-${p.id}">
    <header class="post-head">${who(p.author)} <span class="sep">·</span> <a class="muted small" href="#post-${p.id}">${timeTag(p.created_at)}</a>${p.revision > 1 ? ` <span class="sep">·</span> <span class="muted small" title="Edited ${esc(fmtDate(p.updated_at))}">edited</span>` : ''}<span class="post-num muted small">#${n}</span></header>
    <div class="md">${p.body_html}</div>
    ${(p.attachments || []).length ? `<div class="post-images">${p.attachments.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img src="${esc(a.url)}" alt="${esc(a.filename || 'Image')}" loading="lazy" decoding="async"></a>`).join('')}</div>` : ''}
  </article>`;
}
const imageField = (on) => (on ? '<label class="field"><span>Images (optional, up to 4; PNG, JPEG, GIF or WebP, 8 MB each)</span><input type="file" name="attachments" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label>' : '');

function voteForm(base, thread, viewer) {
    if (!viewer.can_vote) return `<div class="vote"><span class="vote-score" title="Score">${num(thread.score)}</span></div>`;
    const btn = (value, icon, label) => {
        const active = thread.my_vote === value;
        return `<button class="vote-btn${active ? ' active' : ''}" type="submit" name="value" value="${active ? 0 : value}" aria-pressed="${active}" aria-label="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
    };
    return `<form class="vote" method="post" action="${esc(base)}/vote">${btn(1, 'fa-arrow-up', 'Upvote')}<span class="vote-score" title="Score">${num(thread.score)}</span>${btn(-1, 'fa-arrow-down', 'Downvote')}</form>`;
}

function threadPage({ space, thread, posts, page, pages, perPage = 50, viewer, user, error = null, draft = '', categories = [], attachmentsEnabled = false }) {
    const base = `/s/${space.slug}/t/${thread.slug}`;
    const opening = posts.find((p) => p.is_opening) || null;
    const gated = !!(space.members_only || thread.members_only);
    const indexable = space.visibility === 'public' && !gated;
    const first = (page - 1) * perPage;
    const replyBlock = viewer.can_reply
        ? `<form class="paste-form reply-form" method="post" action="${esc(base)}/reply" id="reply"${attachmentsEnabled ? ' enctype="multipart/form-data"' : ''}>
    ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
    <label class="field"><span>Reply (Markdown)</span><textarea name="body" rows="7" maxlength="40000" required placeholder="Say it, own it.">${esc(draft)}</textarea></label>
    ${imageField(attachmentsEnabled)}
    <div class="form-actions"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-reply" aria-hidden="true"></i> Reply</button><span class="muted small">**bold**, *italic*, \`code\`, \`\`\` blocks, [links](https://…), &gt; quotes and lists.</span></div>
  </form>`
        : thread.locked ? '<p class="alert">This thread is locked.</p>'
            : !user ? `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(base)}">Sign in with your OpenVibe account</a> to reply.</p>` : '';
    const modBlock = viewer.can_moderate || viewer.can_delete ? `<div class="actions mod-actions">
    ${viewer.can_moderate ? `<form method="post" action="${esc(base)}/state"><input type="hidden" name="pinned" value="${thread.pinned ? 0 : 1}"><button class="btn btn-sm" type="submit"><i class="fa-solid fa-thumbtack" aria-hidden="true"></i> ${thread.pinned ? 'Unpin' : 'Pin'}</button></form>
    <form method="post" action="${esc(base)}/state"><input type="hidden" name="locked" value="${thread.locked ? 0 : 1}"><button class="btn btn-sm" type="submit"><i class="fa-solid fa-lock" aria-hidden="true"></i> ${thread.locked ? 'Unlock' : 'Lock'}</button></form>` : ''}
    ${viewer.can_delete ? `<form method="post" action="${esc(base)}/delete"><button class="btn btn-sm btn-danger" type="submit"><i class="fa-solid fa-trash" aria-hidden="true"></i> Delete thread</button></form>` : ''}
    ${viewer.can_gate ? `<form method="post" action="${esc(base)}/members-only"><input type="hidden" name="on" value="${thread.members_only ? 0 : 1}"><button class="btn btn-sm" type="submit"><i class="fa-solid fa-star" aria-hidden="true"></i> ${thread.members_only ? 'Open to everyone' : 'VIP members only'}</button></form>` : ''}
    ${viewer.can_moderate && (space.statuses || []).length && thread.status ? `<form class="inline-form" method="post" action="${esc(base)}/status"><label class="sr-only" for="thread-status">Status</label><select id="thread-status" name="status">${space.statuses.map((st) => `<option value="${esc(st)}"${st === thread.status ? ' selected' : ''}>${esc(STATUS_LABELS[st] || st)}</option>`).join('')}</select><button class="btn btn-sm" type="submit">Set status</button></form>` : ''}
    ${categories.length && (viewer.can_moderate || viewer.can_delete) ? `<form class="inline-form" method="post" action="${esc(base)}/category"><label class="sr-only" for="thread-category">Category</label><select id="thread-category" name="category"><option value="">No category</option>${categories.map((c) => `<option value="${esc(c.slug)}"${thread.category && thread.category.slug === c.slug ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select><button class="btn btn-sm" type="submit">Set category</button></form>` : ''}
  </div>` : '';

    const body = `
<article class="thread">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/s">Spaces</a> › <a href="/s/${esc(space.slug)}">${esc(space.name)}</a> › <span aria-current="page">${esc(seo.clean(thread.title, 60))}</span></nav>
  <header class="thread-head">
    ${voteForm(base, thread, viewer)}
    <div>
      <h1>${thread.pinned ? '<i class="fa-solid fa-thumbtack" title="Pinned" aria-label="Pinned"></i> ' : ''}${thread.locked ? '<i class="fa-solid fa-lock" title="Locked" aria-label="Locked"></i> ' : ''}${esc(thread.title)}${vipBadge(thread)}</h1>
      ${thread.status || thread.category ? `<p class="thread-tags">${statusBadge(thread)}${categoryBadge(thread, space)}</p>` : ''}
      <p class="paste-meta">${who(thread.author)} <span class="sep">·</span> <time datetime="${esc(thread.created_at || '')}">${esc(fmtDate(thread.created_at))}</time> <span class="sep">·</span> <span class="stat"><i class="fa-solid fa-comment" aria-hidden="true"></i> ${num(thread.reply_count)} ${thread.reply_count === 1 ? 'reply' : 'replies'}</span></p>
    </div>
  </header>
  ${modBlock}
  <div class="posts">${posts.map((p, i) => postHtml(p, first + i + 1)).join('\n')}</div>
  ${pager((n) => `${base}${n > 1 ? `?page=${n}` : ''}`, page, pages, ['Earlier', 'Later'])}
  ${page === pages ? replyBlock : `<p class="muted"><a href="${esc(base)}?page=${pages}#reply">Go to the last page to reply</a></p>`}
</article>`;
    const description = gated ? `A thread for VIP members in ${space.name} on OpenVibe.Community.` : (seo.clean(opening ? markdownToText(opening.body_markdown, 200) : thread.title, 200) || thread.title);
    return renderPage({
        title: `${thread.title}${page > 1 ? ` (page ${page})` : ''}`,
        description,
        canonicalPath: `${base}${page > 1 ? `?page=${page}` : ''}`,
        robots: indexable ? 'index,follow' : 'noindex,nofollow',
        ogType: 'article',
        published: thread.created_at || undefined,
        modified: (opening && opening.updated_at) || undefined,
        active: 'spaces',
        historyType: 'page',
        historyTitle: thread.title,
        footerVariant: 'compact',
        feeds: indexable ? [{ title: `OpenVibe.Community — ${space.name}`, href: `/s/${space.slug}/feed.xml` }] : [],
        jsonLd: [
            ...(gated ? [] : [seo.threadLd({ space, thread, posts, opening, description })]),
            seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Spaces', url: '/s' }, { name: space.name, url: `/s/${space.slug}` }, { name: thread.title, url: base }]),
        ],
        body,
    });
}

// ── /s/:space/new ────────────────────────────────────────────
function newThreadPage({ space, user, values = {}, error = null, categories = [], attachments = false }) {
    const categoryField = categories.length ? `<label class="field"><span>Category</span><select name="category"><option value="">None</option>${categories.map((c) => `<option value="${esc(c.slug)}"${values.category === c.slug ? ' selected' : ''}>${esc(c.name)}${c.description ? ` — ${esc(c.description)}` : ''}</option>`).join('')}</select></label>` : '';
    const form = user ? `<form class="paste-form" method="post" action="/s/${esc(space.slug)}/new"${attachments ? ' enctype="multipart/form-data"' : ''}>
  ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
  ${space.thread_kind === 'request' ? '<p class="muted small">A request is open to votes. Search first: if it is already here, vote for it instead.</p>' : ''}
  <label class="field"><span>Title</span><input type="text" name="title" minlength="3" maxlength="200" required value="${esc(values.title || '')}" placeholder="What is it about?"></label>
  ${categoryField}
  <label class="field"><span>Post (Markdown)</span><textarea name="body" rows="14" maxlength="40000" required placeholder="Say it, own it.">${esc(values.body || '')}</textarea></label>
  ${imageField(attachments)}
  <label class="check"><input type="checkbox" name="members_only" value="1"${values.members_only ? ' checked' : ''}> Only my OpenVibe.VIP members can read and reply</label>
  <div class="form-actions">
    <button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Post thread</button>
    <span class="muted small">Posting as <strong>${esc(user.display_name || user.username || 'you')}</strong>. By posting you agree to the <a href="/terms">rules</a>.</span>
  </div>
</form>` : `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(`/s/${space.slug}/new`)}">Sign in with your OpenVibe account</a> to start a thread. Reading needs no account.</p>`;
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/s">Spaces</a> › <a href="/s/${esc(space.slug)}">${esc(space.name)}</a> › <span aria-current="page">New thread</span></nav>
  <h1>New thread in ${esc(space.name)}</h1>
</header>
${form}`;
    return renderPage({
        title: `New thread · ${space.name}`,
        description: `Start a thread in ${space.name} on OpenVibe.Community.`,
        canonicalPath: `/s/${space.slug}/new`,
        robots: 'noindex,follow',
        active: 'spaces',
        footerVariant: 'compact',
        body,
    });
}

// ── members-only teaser (403) ────────────────────────────────
/**
 * What someone without the creator's VIP membership sees: the space (and thread title), why, and
 * the join link — never a post. `reason` is VIP's (not_signed_in, not_a_member, vip_unavailable, …).
 */
function membersOnlyPage({ space, thread = null, members_only: mo = null, reason, user, next = '/s' }) {
    const creator = mo && mo.owner_username ? `@${mo.owner_username}` : 'this creator';
    const why = reason === 'not_signed_in' || !user
        ? `<p><a class="btn" href="/auth/login?next=${encodeURIComponent(next)}">Sign in</a> if you are already a member.</p>`
        : reason === 'vip_unavailable' || reason === 'entitlement_unknown'
            ? '<p class="muted">We could not confirm your membership just now. Try again in a moment.</p>'
            : '<p class="muted">Your account does not have an active membership for this.</p>';
    const crumbs = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/s">Spaces</a> › ${thread ? `<a href="/s/${esc(space.slug)}">${esc(space.name)}</a> › <span aria-current="page">${esc(seo.clean(thread.title, 60))}</span>` : `<span aria-current="page">${esc(space.name)}</span>`}</nav>`;
    const body = `
<header class="page-head">
  ${crumbs}
  <h1>${esc(thread ? thread.title : space.name)} <span class="badge badge-vis badge-vip"><i class="fa-solid fa-star" aria-hidden="true"></i> VIP members only</span></h1>
  ${!thread && space.description ? `<p class="muted">${esc(space.description)}</p>` : ''}
</header>
<section class="members-only">
  <p>This ${thread ? 'thread' : 'space'} is for members of ${esc(creator)} on OpenVibe.VIP. Members read and reply; everyone else sees this page.</p>
  <p>${vipJoin(mo)}</p>
  ${why}
</section>`;
    return renderPage({
        title: `${thread ? thread.title : space.name} · members only`,
        description: `For ${creator}'s OpenVibe.VIP members on OpenVibe.Community.`,
        canonicalPath: thread ? `/s/${space.slug}/t/${thread.slug}` : `/s/${space.slug}`,
        robots: 'noindex,nofollow',
        active: 'spaces',
        footerVariant: 'compact',
        body,
    });
}

module.exports = { spacesPage, spacePage, threadPage, newThreadPage, membersOnlyPage, spaceHref, who };
