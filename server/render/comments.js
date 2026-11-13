'use strict';

/**
 * A comment thread's own page — /c/:accessId. The same thread another product embeds (a Live VOD
 * or clip, a wiki page, a blog post), read here straight from Community's store, so both places
 * always show the same comments. Complete without JavaScript: older comments are a link, commenting
 * is a plain form post. Messages are plain text, always escaped.
 */
const config = require('../config');
const { renderPage, asset } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { timeTag, fmtDate, num } = require('./pages');
const { who } = require('./forum');
const { renderThread } = require('openvibe-shared/thread');

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
    ${c.reply_to && c.reply_to_id !== c.parent_id ? `<p class="muted small">Replying to ${esc(c.reply_to.display_name)}</p>` : ''}
    <p class="comment-text">${esc(c.message)}</p>
    ${attachmentsHtml(c.attachments)}
    ${repliesHtml(c)}
  </article>`;
}

function attachmentsHtml(items) {
    const refs = Array.isArray(items) ? items : [];
    if (!refs.length) return '';
    return `<ul class="comment-attachments">${refs.map((a) => {
        const url = `${config.mediaUrl}/o/${encodeURIComponent(String(a.id || ''))}`;
        if (!/^https:\/\//i.test(url)) return '';
        const name = esc(a.name || 'file');
        const type = String(a.media_type || '');
        const body = type.startsWith('image/') ? `<img src="${esc(url)}" alt="${name}" loading="lazy">` : name;
        return `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${body}</a></li>`;
    }).join('')}</ul>`;
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
function commentPanel({ page, user, base, action = base, sort = 'top', replyId = null, expandedId = null, expandedReplies = null, error = null, draft = '' }) {
    return renderThread({
        answer: page || { thread: null, comments: [], viewer: { can_comment: true } },
        base, post: action, remove: `${action}/delete`, signedIn: !!user && (!page || page.viewer.can_comment !== false),
        attachmentsAllowed: !page || ['community/paste', 'pics/picture'].includes(`${page.thread.ref.service}/${page.thread.ref.type}`),
        sort, replyId, expandedId, expandedReplies, error, draft,
    });
}

/**
 * page: the comment service's answer for this viewer ({ thread, comments, next_cursor, viewer }).
 */
function threadPage({ accessId, page, user, after = null, sort = 'top', replyId = null, expandedId = null, expandedReplies = null, error = null, draft = '' }) {
    const { thread } = page;
    const ref = thread.ref;
    const what = refName(ref);
    const product = PRODUCTS[ref.service] || ref.service;
    const label = ref.label || `a ${what} on ${product}`;
    const src = sourceUrl(ref);
    const base = `/c/${accessId}`;
    const panel = commentPanel({ page, user, base, action: base, sort, replyId, expandedId, expandedReplies, error, draft });

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
        scripts: ['ov-thread.js'],
        body: `${body}<script src="${asset('js/inline-comments.js')}" defer></script>`, styles: ['kit.css', 'thread.css', 'thread-inline.css'],
    });
}

module.exports = { threadPage, commentPanel, sourceUrl };
