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
 * page: the comment service's answer for this viewer ({ thread, comments, next_cursor, viewer }).
 */
function threadPage({ accessId, page, user, after = null, error = null, draft = '' }) {
    const { thread, comments, next_cursor: next, viewer } = page;
    const ref = thread.ref;
    const what = refName(ref);
    const product = PRODUCTS[ref.service] || ref.service;
    const label = ref.label || `a ${what} on ${product}`;
    const src = sourceUrl(ref);
    const base = `/c/${accessId}`;

    let form = '';
    if (thread.visibility === 'locked' && !viewer.can_moderate) form = '<p class="alert">This comment thread is locked.</p>';
    else if (!user) form = `<p class="alert"><a href="/auth/login?next=${encodeURIComponent(base)}">Sign in with your OpenVibe account</a> to comment.</p>`;
    else if (viewer.can_comment) {
        form = `<form class="paste-form reply-form" method="post" action="${esc(base)}" id="comment">
    ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
    <label class="field"><span>Comment</span><textarea name="message" rows="4" maxlength="2000" required placeholder="Add a comment…">${esc(draft)}</textarea></label>
    <div class="form-actions"><button class="btn btn-primary" type="submit"><i class="fa-solid fa-comment" aria-hidden="true"></i> Comment</button><span class="muted small">Commenting as <strong>${esc(user.display_name || user.username || 'you')}</strong>. It shows on ${esc(product)} too.</span></div>
  </form>`;
    }

    const list = comments.length
        ? `<div class="posts">${comments.map(commentHtml).join('\n')}</div>`
        : `<p class="empty">${after ? 'No older comments.' : 'No comments yet.'}</p>`;
    const older = next ? `<nav class="pager" aria-label="Pages"><span></span><a rel="next" href="${esc(`${base}?after=${encodeURIComponent(next)}`)}">Older comments <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a></nav>` : '';

    const body = `
<article class="thread comment-thread">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Comments</span></nav>
  <header class="page-head">
    <h1>Comments on ${esc(label)}</h1>
    <p class="muted">${num(thread.comment_count)} ${thread.comment_count === 1 ? 'comment' : 'comments'} · one thread, shown here and on ${esc(product)}${src ? ` · <a href="${esc(src)}">Open the ${esc(what)} on ${esc(product)}</a>` : ''}</p>
  </header>
  ${after ? '' : form}
  ${after ? `<p><a href="${esc(base)}">Newest comments</a></p>` : ''}
  ${list}
  ${older}
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

module.exports = { threadPage, sourceUrl };
