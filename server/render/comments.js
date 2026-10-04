'use strict';

/**
 * A comment thread's own page — /c/:accessId. The same thread another product embeds (a Live VOD
 * or clip, a wiki page, a blog post), read here straight from Community's store, so both places
 * always show the same comments. Complete without JavaScript: older comments are a link, commenting
 * is a plain form post. Messages are plain text, always escaped.
 */
const config = require('../config');
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { timeTag, fmtDate, num } = require('./pages');
const { who } = require('./forum');

const REF_NAMES = {
    'live/vod': 'VOD', 'live/clip': 'clip', 'live/stream': 'stream', 'live/channel': 'channel',
    'wiki/page': 'wiki page', 'blog/post': 'blog post', 'community/paste': 'paste', 'community/post': 'post',
};
const PRODUCTS = { live: 'OpenVibe.Live', wiki: 'OpenVibe.Wiki', blog: 'OpenVibe.Blog', community: 'OpenVibe.Community', media: 'OpenVibe.Media', reviews: 'OpenVibe.Reviews' };

/** Where the commented-on thing lives, when Community knows its address. */
function sourceUrl(ref) {
    const id = encodeURIComponent(ref.id);
    if (ref.service === 'live' && ref.type === 'vod') return `${config.liveUrl}/vod/${id}`;
    if (ref.service === 'live' && ref.type === 'clip') return `${config.liveUrl}/clip/${id}`;
    if (ref.service === 'live' && ref.type === 'channel') return `${config.liveUrl}/@${id}`;   // Live's channel page is /@<username>
    if (ref.service === 'live' && ref.type === 'stream') return `${config.liveUrl}/stream/${id}`;
    if (ref.service === 'community' && ref.type === 'paste') return `/p/${id}`;
    return null;
}

function refName(ref) { return REF_NAMES[`${ref.service}/${ref.type}`] || ref.type; }

function commentHtml(c) {
    if (c.deleted) {
        return `<article class="post post-deleted" id="comment-${c.id}"><p class="muted small">This comment was deleted.</p>${repliesHtml(c)}</article>`;
    }
    const edited = c.edited_at ? ` <span class="sep">·</span> <span class="muted small" title="Edited ${esc(fmtDate(c.edited_at))}">edited</span>` : '';
    return `<article class="post comment" id="comment-${c.id}">
    <header class="post-head">${who(c.author || (c.anon_name ? { display_name: c.anon_name } : null))} <span class="sep">·</span> <a class="muted small" href="#comment-${c.id}">${timeTag(c.created_at)}</a>${edited}</header>
    <p class="comment-text">${esc(c.message)}</p>
    ${repliesHtml(c)}
  </article>`;
}

function repliesHtml(c) {
    if (!c.replies || !c.replies.length) return '';
    const more = c.reply_count > c.replies.length ? `<p class="muted small">${num(c.reply_count - c.replies.length)} more ${c.reply_count - c.replies.length === 1 ? 'reply' : 'replies'} on the original page.</p>` : '';
    return `<div class="comment-replies">${c.replies.map(commentHtml).join('\n')}${more}</div>`;
}

/**
 * The comment list and the no-JS form, shared by /c/:accessId and the paste page. page: the comment
 * service's answer for this viewer ({ thread, comments, next_cursor, viewer }), or null while nobody
 * has commented (the first comment opens the thread). base: the page's own address (paging and
 * sorting links, where sign-in returns), action: where the form posts. sort: 'new' or 'old' when the
 * page offers both orders (null: newest first, no sort links). note: HTML after "Commenting as …".
 */
function commentPanel({ page, user, base, action = base, after = null, sort = null, error = null, draft = '', note = '' }) {
    const thread = page ? page.thread : null;
    const comments = page ? page.comments : [];
    const next = page ? page.next_cursor : null;
    const viewer = page ? page.viewer : { can_comment: !!user, can_moderate: false };
    const href = (o = {}) => {
        const q = new URLSearchParams();
        if (o.sort === 'old') q.set('sort', 'old');
        if (o.after) q.set('after', o.after);
        const qs = q.toString();
        return qs ? `${base}?${qs}` : base;
    };

    let form = '';
    if (thread && thread.visibility === 'locked' && !viewer.can_moderate) form = '<p class="alert">This comment thread is locked.</p>';
    else if (!user) form = `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(base)}">Sign in with your OpenVibe account</a> to comment.</p>`;
    else if (viewer.can_comment) {
        form = `<form class="paste-form reply-form" method="post" action="${esc(action)}" id="comment">
    ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
    <label class="field"><span>Comment</span><textarea name="message" rows="4" maxlength="2000" required placeholder="Add a comment…">${esc(draft)}</textarea></label>
    <div class="form-actions"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-comment" aria-hidden="true"></i> Comment</button><span class="muted small">Commenting as <strong>${esc(user.display_name || user.username || 'you')}</strong>.${note ? ` ${note}` : ''}</span></div>
  </form>`;
    }

    const tabs = sort && thread && thread.comment_count > 1
        ? `<nav class="tabs sort-tabs" aria-label="Sort comments">${[['new', 'Newest'], ['old', 'Oldest']].map(([id, label]) => `<a class="tab${id === sort ? ' active' : ''}" href="${esc(href({ sort: id }))}"${id === sort ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`
        : '';
    const list = comments.length
        ? `<div class="posts">${comments.map(commentHtml).join('\n')}</div>`
        : `<p class="empty">${after ? 'No older comments.' : 'No comments yet.'}</p>`;
    const older = next ? `<nav class="pager" aria-label="Pages"><span></span><a rel="next" href="${esc(href({ sort, after: next }))}">${sort === 'old' ? 'More' : 'Older'} comments <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a></nav>` : '';

    return `${after ? '' : form}
  ${after ? `<p><a href="${esc(href({ sort }))}">${sort === 'old' ? 'First' : 'Newest'} comments</a></p>` : ''}
  ${tabs}
  ${list}
  ${older}`;
}

/**
 * page: the comment service's answer for this viewer ({ thread, comments, next_cursor, viewer }).
 */
function threadPage({ accessId, page, user, after = null, error = null, draft = '' }) {
    const { thread } = page;
    const ref = thread.ref;
    const what = refName(ref);
    const product = PRODUCTS[ref.service] || ref.service;
    const label = ref.label || `a ${what} on ${product}`;
    const src = sourceUrl(ref);
    const base = `/c/${accessId}`;
    const panel = commentPanel({ page, user, base, after, error, draft, note: `It shows on ${esc(product)} too.` });

    const body = `
<article class="thread comment-thread">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Comments</span></nav>
  <header class="page-head">
    <h1>Comments on ${esc(label)}</h1>
    <p class="muted">${num(thread.comment_count)} ${thread.comment_count === 1 ? 'comment' : 'comments'} · one thread, shown here and on ${esc(product)}${src ? ` · <a href="${esc(src)}">Open the ${esc(what)} on ${esc(product)}</a>` : ''}</p>
  </header>
  ${panel}
</article>`;
    return renderPage({
        title: `Comments on ${label}`,
        description: `${num(thread.comment_count)} comments on ${label}, the same thread ${product} shows.`,
        canonicalPath: base,
        // The access id is the only thing keeping an unlisted item's thread unlisted: never indexed.
        robots: 'noindex,nofollow',
        active: 'comments',
        footerVariant: 'compact',
        body,
    });
}

module.exports = { threadPage, commentPanel, sourceUrl };
