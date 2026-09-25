'use strict';

/**
 * Forum-style pages, after vBulletin and SMF: the board index at /s (every space, grouped, with topics,
 * posts and the last post), a forum-style space as a topic table (Replies, Views, Last post; sticky topics
 * first; bumped by the newest post) and a topic as posts with the author's panel beside each (picture,
 * posts, since when, the ratings they get most), with Quote. Feed-style spaces keep render/forum.js
 * (subreddit-like cards, votes, hot/new/top); both share threads, posts, ratings, images and pastes.
 * Complete without JavaScript: every action is a link or a form post.
 */
const seo = require('../seo');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { markdownToText } = require('./markdown');
const { timeTag, fmtDate, num, avatarUrl } = require('./pages');
const f = require('./forum');

const STYLE_LABELS = { forum: 'Forum', feed: 'Feed' };
const monthYear = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null; };
const crumbs = (items) => `<nav class="crumbs" aria-label="Breadcrumb">${items.map(([label, href], i) => (i === items.length - 1 ? `<span aria-current="page">${esc(label)}</span>` : `<a href="${esc(href)}">${esc(label)}</a>`)).join(' › ')}</nav>`;
const trail = (space) => [['Home', '/'], ['Spaces', '/s'], ...(space.group ? [[space.group.name, `/s#g-${space.group.slug}`]] : []), ...(space.parent ? [[space.parent.name, `/s/${space.parent.slug}`]] : [])];
const plural = (n, one, many) => `${num(n)} ${n === 1 ? one : many}`;

/** One space as a board-index row: icon, name, description, child boards, topics, posts, last post. */
function boardRow(sp) {
    const icon = sp.style === 'forum' ? 'fa-comments' : 'fa-fire';
    const last = sp.last_post
        ? `<a href="${esc(sp.last_post.thread.url)}#post-${Number(sp.last_post.id)}">${esc(seo.clean(sp.last_post.thread.title, 48))}</a><span class="small muted">by ${esc(sp.last_post.author ? (sp.last_post.author.display_name || sp.last_post.author.username || 'someone') : 'someone')} · ${timeTag(sp.last_post.created_at)}</span>`
        : '<span class="muted small">No posts yet</span>';
    const children = (sp.children || []).length ? `<p class="small board-children">Child boards: ${sp.children.map((c) => `<a href="/s/${esc(c.slug)}">${esc(c.name)}</a>`).join(', ')}</p>` : '';
    return `<tr>
      <td class="board-name"><span class="board-icon" aria-hidden="true"><i class="fa-solid ${icon}"></i></span><div>
        <a class="board-title" href="/s/${esc(sp.slug)}">${esc(sp.name)}</a> <span class="badge badge-style">${STYLE_LABELS[sp.style] || 'Feed'}</span>${f.visBadge(sp)}
        ${sp.description ? `<p class="muted small">${esc(sp.description)}</p>` : ''}${children}
      </div></td>
      <td class="num" data-label="Topics">${num(sp.thread_count)}</td>
      <td class="num" data-label="Posts">${num(sp.post_count)}</td>
      <td class="board-last" data-label="Last post">${last}</td>
    </tr>`;
}

function boardTable(spaces, caption) {
    return `<table class="board-table"><caption class="sr-only">${esc(caption)}</caption>
    <thead><tr><th scope="col">Space</th><th scope="col" class="num">Topics</th><th scope="col" class="num">Posts</th><th scope="col">Last post</th></tr></thead>
    <tbody>${spaces.map(boardRow).join('')}</tbody></table>`;
}

// ── /s ───────────────────────────────────────────────────────
function boardIndexPage({ groups = [], user, canModerate = false }) {
    const body = `
<header class="page-head">
  ${crumbs([['Home', '/'], ['Spaces', '/s']])}
  <h1>Spaces</h1>
  <p class="muted">Forums and feeds for the people of OpenVibe. Forum boards read like a classic forum, newest reply on top. Feeds rank posts by votes. Read without an account; sign in to post, rate and vote. See what is happening across the network on <a href="/pulse">Pulse</a>.</p>
  ${canModerate ? '<p><a class="btn btn-sm" href="/s/new-space"><i class="fa-solid fa-plus" aria-hidden="true"></i> New space</a></p>' : ''}
</header>
${groups.length ? groups.map((g) => `<section class="board-group" id="g-${esc(g.slug || 'more')}" aria-labelledby="gh-${esc(g.slug || 'more')}">
  <h2 class="board-group-h" id="gh-${esc(g.slug || 'more')}">${esc(g.name)}</h2>
  ${g.description ? `<p class="muted small board-group-p">${esc(g.description)}</p>` : ''}
  ${boardTable(g.spaces, g.name)}
</section>`).join('') : '<p class="empty">No spaces yet.</p>'}
${user ? '' : '<p class="muted small">Sign in with your OpenVibe account to post.</p>'}`;
    return renderPage({
        title: 'Spaces',
        description: 'Forums and feeds on OpenVibe.Community: general talk, help, feedback and feature requests, the roadmap, a showcase of what people make, and off-topic.',
        canonicalPath: '/s',
        active: 'spaces',
        feeds: [{ title: 'OpenVibe.Community — latest threads', href: '/s/feed.xml' }],
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Spaces', url: '/s' }])],
        body,
    });
}

/** A topic's page links (1 2 3 … last) for the topic table. */
function topicPages(base, pages) {
    if (pages <= 1) return '';
    const n = pages <= 5 ? Array.from({ length: pages }, (_, i) => i + 1) : [1, 2, 3, null, pages];
    return ` <span class="topic-pages">Pages: ${n.map((p) => (p ? `<a href="${esc(base)}${p > 1 ? `?page=${p}` : ''}">${p}</a>` : '…')).join(' ')}</span>`;
}

function topicRow(t, space) {
    const base = `/s/${space.slug}/t/${t.slug}`;
    const icon = t.locked ? 'fa-lock' : t.pinned ? 'fa-thumbtack' : t.reply_count >= 15 ? 'fa-fire-flame-curved' : 'fa-comment';
    const label = t.locked ? 'Locked' : t.pinned ? 'Sticky' : t.reply_count >= 15 ? 'Hot topic' : 'Topic';
    const who = (a) => esc(a ? (a.display_name || a.username || 'someone') : 'someone');
    return `<tr class="${t.pinned ? 'sticky' : ''}">
      <td class="topic-icon" aria-hidden="true"><i class="fa-solid ${icon}" title="${label}"></i></td>
      <td class="topic-main">${t.pinned ? '<span class="badge badge-sticky">Sticky</span> ' : ''}<a class="topic-title" href="${esc(base)}">${esc(t.title)}</a>${f.statusBadge(t)}${f.categoryBadge(t, space)}${f.vipBadge(t)}
        <span class="small muted topic-by">Started by ${who(t.author)} · ${timeTag(t.created_at)}${topicPages(base, t.pages || 1)}</span></td>
      <td class="num" data-label="Replies">${num(t.reply_count)}</td>
      <td class="num" data-label="Views">${num(t.views)}</td>
      <td class="board-last" data-label="Last post">${timeTag(t.last_activity_at)}<span class="small muted">by ${who(t.last_post ? t.last_post.author : t.author)}${t.last_post ? ` <a href="${esc(base)}${t.pages > 1 ? `?page=${t.pages}` : ''}#post-${Number(t.last_post.id)}" aria-label="Go to the last post">»</a>` : ''}</span></td>
    </tr>`;
}

/** Moderators: the space's settings (style, votes, ratings, group, description), no JS. */
function settingsForm(space, groups = []) {
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    return `<details class="space-settings"><summary><i class="fa-solid fa-gear" aria-hidden="true"></i> Space settings</summary>
<form class="paste-form" method="post" action="/s/${esc(space.slug)}/settings">
  <label class="field"><span>Name</span><input name="name" required minlength="2" maxlength="60" value="${esc(space.name)}"></label>
  <label class="field"><span>Description</span><input name="description" maxlength="300" value="${esc(space.description || '')}"></label>
  <label class="field"><span>Style</span><select name="style">${opt('forum', 'Forum: newest reply first, author panels, quotes', space.style === 'forum')}${opt('feed', 'Feed: ranked by votes, hot/new/top', space.style !== 'forum')}</select></label>
  <label class="check"><input type="checkbox" name="votes" value="1"${space.votes ? ' checked' : ''}> Up and down votes</label>
  <label class="check"><input type="checkbox" name="reactions" value="1"${space.reactions ? ' checked' : ''}> Ratings on posts (Agree, Winner, Funny…)</label>
  <label class="field"><span>Group on the board index</span><select name="group">${opt('', 'None', !space.group)}${groups.map((g) => opt(g.slug, g.name, space.group && space.group.slug === g.slug)).join('')}</select></label>
  <div class="form-actions"><button class="btn btn-primary" type="submit">Save settings</button></div>
</form></details>`;
}

// ── /s/:space (forum style) ──────────────────────────────────
function forumSpacePage({ space, threads, page, pages, total, user, categories = [], category = null, status = null, viewer = {}, children = [], groups = [] }) {
    const filtered = !!(category || status);
    const indexable = space.visibility === 'public' && !space.members_only && !filtered;
    const href = (o = {}) => f.spaceHref(space.slug, { sort: 'active', category, status, ...o }).replace(/[?&]sort=active/, '').replace(/\?&/, '?').replace(/\?$/, '');
    const chip = (label, h, on) => `<a class="chip${on ? ' active' : ''}" href="${esc(h)}"${on ? ' aria-current="true"' : ''}>${label}</a>`;
    const tags = categories.length ? `<nav class="chips" aria-label="Categories">${chip('All', href({ category: null }), !category)}${categories.map((c) => chip(esc(c.name), href({ category: c.slug }), c.slug === category)).join('')}</nav>` : '';
    const statuses = (space.statuses || []).length ? `<nav class="chips" aria-label="Status">${chip('Any status', href({ status: null }), !status)}${space.statuses.map((st) => chip(esc(f.STATUS_LABELS[st] || st), href({ status: st }), st === status)).join('')}</nav>` : '';
    const start = viewer.can_start !== false
        ? `<a class="btn btn-primary" href="/s/${esc(space.slug)}/new"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${space.thread_kind === 'request' ? 'New request' : 'New topic'}</a>`
        : '<span class="muted small">Staff add roadmap items; reply to one to discuss it.</span>';
    const pagerHtml = f.pager((n) => href({ page: n }), page, pages, ['Previous', 'Next']);
    const body = `
<header class="page-head">
  ${crumbs([...trail(space), [space.name, `/s/${space.slug}`]])}
  <h1>${esc(space.name)}${f.visBadge(space)}</h1>
  ${space.description ? `<p class="muted">${esc(space.description)}</p>` : ''}
</header>
${children.length ? `<section class="board-group" aria-label="Child boards">${boardTable(children, 'Child boards')}</section>` : ''}
<div class="board-toolbar">${start}${user ? '' : ' <span class="muted small">Sign in with your OpenVibe account to post.</span>'}</div>
${tags}${statuses}
<section data-results>
${threads.length ? `<table class="board-table topic-table"><caption class="sr-only">Topics in ${esc(space.name)}</caption>
  <thead><tr><th scope="col" class="topic-icon"><span class="sr-only">Kind</span></th><th scope="col">Topic</th><th scope="col" class="num">Replies</th><th scope="col" class="num">Views</th><th scope="col">Last post</th></tr></thead>
  <tbody>${threads.map((t) => topicRow(t, space)).join('')}</tbody></table>` : `<p class="empty">${filtered ? `Nothing here yet. <a href="${esc(href({ category: null, status: null }))}">See every topic</a>.` : viewer.can_start !== false ? `No topics yet — <a href="/s/${esc(space.slug)}/new">start the first one</a>.` : 'Nothing here yet.'}</p>`}
${pagerHtml}
</section>
${viewer.can_moderate ? settingsForm(space, groups) : ''}`;
    return renderPage({
        title: `${space.name}${page > 1 ? ` (page ${page})` : ''}`,
        description: `${space.description || `Topics in ${space.name}`} ${plural(total, 'topic', 'topics')} on OpenVibe.Community.`,
        canonicalPath: href({ page }),
        robots: indexable ? 'index,follow' : filtered && space.visibility === 'public' && !space.members_only ? 'noindex,follow' : 'noindex,nofollow',
        active: 'spaces',
        feeds: indexable ? [{ title: `OpenVibe.Community — ${space.name}`, href: `/s/${space.slug}/feed.xml` }] : [],
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Spaces', url: '/s' }, { name: space.name, url: `/s/${space.slug}` }])],
        body,
    });
}

/** The author's panel beside a post: picture, name, posts, since when, the ratings they get most. */
function authorPanel(p) {
    const a = p.author;
    if (!a) return '<aside class="postbit-author"><span class="postbit-name">Anonymous</span></aside>';
    const pic = avatarUrl(a, 96);
    const name = a.display_name || a.username || (a.is_ai ? 'AI' : a.is_system ? 'OpenVibe' : 'Someone');
    const initial = esc(String(name).trim()[0] || '?').toUpperCase();
    const st = p.author_stats;
    return `<aside class="postbit-author">
      ${pic ? `<img class="postbit-avatar" src="${esc(pic)}" alt="" width="64" height="64" loading="lazy">` : `<span class="postbit-avatar postbit-letter" aria-hidden="true">${initial}</span>`}
      <span class="postbit-name">${a.username ? `<a href="https://openvibe.live/@${encodeURIComponent(a.username)}" rel="noopener">${esc(name)}</a>` : esc(name)}</span>
      ${a.is_ai ? '<span class="badge badge-ai" title="Written by AI, not by a person">AI</span>' : a.is_system ? '<span class="badge">OpenVibe</span>' : ''}
      ${st ? `<dl class="postbit-stats"><div><dt>Posts</dt><dd>${num(st.posts)}</dd></div>${monthYear(st.first_post_at) ? `<div><dt>Since</dt><dd>${esc(monthYear(st.first_post_at))}</dd></div>` : ''}</dl>
      ${(st.ratings || []).length ? `<p class="postbit-ratings" aria-label="Ratings received">${st.ratings.map((r) => `<span title="${esc(r.label)}">${r.emoji} ${num(r.count)}</span>`).join(' ')}</p>` : ''}` : ''}
    </aside>`;
}

function postbit(p, n, { base, page, catalogue, canReply }) {
    if (p.deleted) return `<article class="postbit post-deleted" id="post-${p.id}"><div class="postbit-main"><p class="muted small">#${n} · This post was deleted.</p></div></article>`;
    const quote = canReply ? ` <a class="small" href="${esc(base)}?quote=${Number(p.id)}#reply"><i class="fa-solid fa-quote-left" aria-hidden="true"></i> Quote</a>` : '';
    return `<article class="postbit${p.is_opening ? ' post-opening' : ''}" id="post-${p.id}">
    ${authorPanel(p)}
    <div class="postbit-main">
      <header class="postbit-head small muted"><a href="#post-${p.id}">${p.is_opening ? 'Topic' : `Reply #${n - 1}`}</a> · ${esc(fmtDate(p.created_at))}${p.revision > 1 ? ` · <span title="Edited ${esc(fmtDate(p.updated_at))}">edited</span>` : ''}${quote}</header>
      <div class="md">${p.body_html}</div>
      ${f.postImages(p)}
      ${f.pasteCards(p)}
      ${f.reactionBar(p, base, page, catalogue)}
    </div>
  </article>`;
}

// ── /s/:space/t/:slug (forum style) ──────────────────────────
function forumTopicPage({ space, thread, posts, page, pages, perPage = 50, viewer, user, error = null, draft = '', categories = [], attachmentsEnabled = false, reactions = [], crosspost = null }) {
    const base = `/s/${space.slug}/t/${thread.slug}`;
    const opening = posts.find((p) => p.is_opening) || null;
    const gated = !!(space.members_only || thread.members_only);
    const indexable = space.visibility === 'public' && !gated;
    const first = (page - 1) * perPage;
    const replyBlock = viewer.can_reply
        ? `<form class="paste-form reply-form" method="post" action="${esc(base)}/reply" id="reply"${attachmentsEnabled ? ' enctype="multipart/form-data"' : ''}>
    <h2 class="h3">Reply</h2>
    ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
    <label class="field"><span class="sr-only">Your reply (Markdown)</span><textarea name="body" rows="7" maxlength="40000" required placeholder="Say it, own it.">${esc(draft)}</textarea></label>
    ${f.imageField(attachmentsEnabled)}
    ${f.pasteField()}
    <div class="form-actions"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-reply" aria-hidden="true"></i> Post reply</button><span class="muted small">**bold**, *italic*, \`code\`, &gt; quotes, [links](https://…)</span></div>
  </form>`
        : thread.locked ? '<p class="alert">This topic is locked.</p>'
            : !user ? `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(base)}">Sign in with your OpenVibe account</a> to reply.</p>` : '';
    const pagerHtml = f.pager((n) => `${base}${n > 1 ? `?page=${n}` : ''}`, page, pages, ['Previous', 'Next']);
    const body = `
<article class="thread forum-topic">
  ${crumbs([...trail(space), [space.name, `/s/${space.slug}`], [seo.clean(thread.title, 60), base]])}
  <header class="thread-head">
    ${space.votes === false ? '' : f.voteForm(base, thread, viewer)}
    <div>
      <h1>${thread.pinned ? '<i class="fa-solid fa-thumbtack" title="Sticky" aria-label="Sticky"></i> ' : ''}${thread.locked ? '<i class="fa-solid fa-lock" title="Locked" aria-label="Locked"></i> ' : ''}${esc(thread.title)}${f.vipBadge(thread)}</h1>
      ${thread.status || thread.category ? `<p class="thread-tags">${f.statusBadge(thread)}${f.categoryBadge(thread, space)}</p>` : ''}
      <p class="small muted">${plural(thread.reply_count, 'reply', 'replies')} · ${plural(thread.views, 'view', 'views')}</p>
    </div>
  </header>
  ${f.crosspostBlock(crosspost, base)}
  ${f.modActions({ base, space, thread, viewer, categories })}
  ${pagerHtml}
  <div class="postbits">${posts.map((p, i) => postbit(p, first + i + 1, { base, page, catalogue: reactions, canReply: viewer.can_reply })).join('\n')}</div>
  ${pagerHtml}
  ${page === pages ? replyBlock : `<p class="muted"><a href="${esc(base)}?page=${pages}#reply">Go to the last page to reply</a></p>`}
</article>`;
    const description = gated ? `A topic for VIP members in ${space.name} on OpenVibe.Community.` : (seo.clean(opening ? markdownToText(opening.body_markdown, 200) : thread.title, 200) || thread.title);
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

/** Moderators: a new space (either style), no JS. */
function newSpacePage({ groups = [], error = null, values = {} }) {
    const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
    const body = `
<header class="page-head">
  ${crumbs([['Home', '/'], ['Spaces', '/s'], ['New space', '/s/new-space']])}
  <h1>New space</h1>
  <p class="muted">A forum board reads like a classic forum: the newest reply on top, author panels and quotes. A feed ranks posts by votes, like a subreddit. You can change the style later.</p>
</header>
<form class="paste-form" method="post" action="/s/new-space">
  ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
  <label class="field"><span>Name</span><input name="name" required minlength="2" maxlength="60" value="${esc(values.name || '')}"></label>
  <label class="field"><span>Address (/s/…)</span><input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,39}" maxlength="40" value="${esc(values.slug || '')}" placeholder="music"></label>
  <label class="field"><span>Description</span><input name="description" maxlength="300" value="${esc(values.description || '')}"></label>
  <label class="field"><span>Style</span><select name="style">${opt('forum', 'Forum', values.style !== 'feed')}${opt('feed', 'Feed', values.style === 'feed')}</select></label>
  <label class="check"><input type="checkbox" name="votes" value="1"${values.votes ? ' checked' : ''}> Up and down votes</label>
  <label class="check"><input type="checkbox" name="reactions" value="1"${values.reactions !== false ? ' checked' : ''}> Ratings on posts</label>
  <label class="field"><span>Group on the board index</span><select name="group">${opt('', 'None', !values.group)}${groups.map((g) => opt(g.slug, g.name, values.group === g.slug)).join('')}</select></label>
  <div class="form-actions"><button class="btn btn-primary" type="submit">Create space</button></div>
</form>`;
    return renderPage({ title: 'New space', canonicalPath: '/s/new-space', robots: 'noindex,nofollow', active: 'spaces', footerVariant: 'compact', body });
}

/** "Discuss in a space": pick where a paste should be talked about; each space's new-topic form attaches it. */
function discussPage({ groups = [], paste = '', user }) {
    const q = paste ? `?paste=${encodeURIComponent(paste)}` : '';
    const body = `
<header class="page-head">
  ${crumbs([['Home', '/'], ['Spaces', '/s'], ['Discuss', '/s/discuss']])}
  <h1>Discuss${paste ? ' this paste' : ''} in a space</h1>
  <p class="muted">Pick a space. Its new-topic form opens with ${paste ? `the paste <a href="/p/${esc(paste)}">${esc(paste)}</a>` : 'your paste'} attached.</p>
  ${user ? '' : `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(`/s/discuss${q}`)}">Sign in with your OpenVibe account</a> to start a topic.</p>`}
</header>
${groups.map((g) => `<section class="board-group"><h2 class="board-group-h">${esc(g.name)}</h2><ul class="discuss-list">${g.spaces.filter((sp) => sp.thread_kind !== 'roadmap').map((sp) => `<li><a class="btn" href="/s/${esc(sp.slug)}/new${q}">${esc(sp.name)}</a> <span class="muted small">${esc(sp.description || '')}</span></li>`).join('')}</ul></section>`).join('')}`;
    return renderPage({ title: 'Discuss in a space', canonicalPath: '/s/discuss', robots: 'noindex,follow', active: 'spaces', footerVariant: 'compact', body });
}

module.exports = { boardIndexPage, forumSpacePage, forumTopicPage, newSpacePage, settingsForm, discussPage };
