'use strict';

/** Plain, server-rendered Community thread for the Video and Pics item pages. */
const thread = require('openvibe-shared/thread');
const { escapeHtml: esc } = require('./highlight');

const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const USERNAME = /^[A-Za-z0-9_]{1,32}$/;
const ID = /^\d{1,15}$/;
const safeHttps = (value) => { try { const url = new URL(String(value)); return url.protocol === 'https:' ? url.href : null; } catch { return null; } };
const author = (c) => c.author || c;
const username = (c) => author(c).username || c.username || '';
const name = (c) => author(c).display_name || c.display_name || username(c) || c.anon_name || 'Member';
const date = (iso) => {
    const ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms)) return { short: '', full: '' };
    const full = new Date(ms).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
    const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    const unit = seconds < 60 ? ['second', seconds] : seconds < 3600 ? ['minute', Math.floor(seconds / 60)]
        : seconds < 86400 ? ['hour', Math.floor(seconds / 3600)] : seconds < 2592000 ? ['day', Math.floor(seconds / 86400)]
            : seconds < 31536000 ? ['month', Math.floor(seconds / 2592000)] : ['year', Math.floor(seconds / 31536000)];
    return { short: seconds < 60 ? 'just now' : `${unit[1]} ${unit[0]}${unit[1] === 1 ? '' : 's'} ago`, full };
};

function query(base, sort, extra = {}, anchor = 'comments') {
    const q = new URLSearchParams({ sort, ...extra });
    return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}#${anchor}`;
}

function renderThread({ answer, base, post, remove, signedIn, attachmentsAllowed = true, sort = 'top', replyId = null, expandedId = null, expandedReplies = null, error = null, draft = '' }) {
    const comments = Array.isArray(answer && answer.comments) ? answer.comments : [];
    const accessId = answer && answer.thread && String(answer.thread.access_id || answer.thread.id || '');
    const threadUrl = safeHttps(answer && answer.thread && answer.thread.url) || (/^cth_[A-Za-z0-9_-]{22}$/.test(accessId) ? `https://openvibe.community/c/${accessId}` : null);
    const validReply = ID.test(String(replyId || '')) ? String(replyId) : null;
    const validExpanded = ID.test(String(expandedId || '')) ? String(expandedId) : null;
    // Signed out, the composer's spot is one line; with no comments yet that line is the whole empty state (no second
    // box saying the same thing).
    const signIn = `<p class="ovc-signin">${comments.length ? 'Sign in to comment.' : 'Be the first to comment.'} <a class="ovk-btn ovk-btn--primary" href="/auth/login?next=${encodeURIComponent(query(base, sort))}">Sign in</a></p>`;
    const composer = (parent = null) => signedIn ? thread.composer({ action: post, name: 'message', label: 'Comment', placeholder: parent ? 'Write a reply…' : 'Add a comment…', value: draft, maxlength: 2000,
        sendLabel: parent ? 'Reply' : 'Comment', hidden: parent ? { parent_id: parent } : {},
        attach: attachmentsAllowed ? { name: 'files', accept: 'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain' } : null,
        note: attachmentsAllowed ? 'Up to four files, 16 MB each. JPEG, PNG, GIF, WebP, PDF or text.' : '',
    }) : signIn;
    const attachments = (c) => (Array.isArray(c.attachments) ? c.attachments : []).map((a) => {
        if (!MEDIA_ID.test(String(a.id || ''))) return '';
        const url = `https://openvibe.media/o/${a.id}`;
        const title = esc(a.name || 'Attached file');
        return `<a class="ovc-attach${String(a.media_type || '').startsWith('image/') ? ' ovc-attach--image' : ' ovc-attach--file'}" href="${url}" target="_blank" rel="noopener noreferrer">${String(a.media_type || '').startsWith('image/')
            ? `<img src="${url}" alt="${title}" loading="lazy" width="120">` : title}</a>`;
    }).join('');
    const comment = (c, root = null) => {
        const id = String(c.id);
        if (!ID.test(id)) return '';
        const gone = !!(c.deleted || c.is_deleted);
        const user = username(c);
        const profile = USERNAME.test(user) ? `https://openvibe.network/@${encodeURIComponent(user)}` : null;
        const avatar = safeHttps(author(c).avatar_url || c.avatar_url) || (profile ? `https://openvibe.network/avatar/${encodeURIComponent(user)}?s=80` : null);
        const when = date(c.created_at);
        const targetId = ID.test(String(c.reply_to_id || '')) ? String(c.reply_to_id) : null;
        const topId = root || id;
        const target = targetId && c.reply_to ? `<a class="ovc-target" href="${query(base, sort, { replies: topId }, `comment-${targetId}`)}">↪ @${esc(c.reply_to.display_name || 'Member')}</a>` : '';
        const controls = !gone ? `<div class="ovc-actions">${signedIn ? `<a class="ovk-btn ovk-btn--quiet" href="${query(base, sort, { reply: id }, `comment-${id}`)}" data-ovc-reply="${id}">Reply</a>` : ''}${c.can_delete && signedIn ? `<form method="post" action="${esc(remove)}"><input type="hidden" name="comment_id" value="${id}"><button class="ovk-btn ovk-btn--quiet" type="submit">Delete</button></form>` : ''}</div>` : '';
        let replies = '';
        if (!root) {
            const rows = validExpanded === id && Array.isArray(expandedReplies) ? expandedReplies : (Array.isArray(c.replies) ? c.replies : []);
            const more = Math.max(0, Number(c.reply_count || 0) - rows.length);
            replies = `<div class="ovc-replies" data-ovc-replies="${id}">${rows.map((r) => comment(r, id)).join('')}${more ? `<a class="ovc-more ovk-btn ovk-btn--quiet" data-ovc-more="${id}" href="${query(base, sort, { replies: id })}">${more} more ${more === 1 ? 'reply' : 'replies'}</a>` : ''}</div>`;
        }
        return `<article class="ovc-comment" id="comment-${id}"><header>${avatar ? `<img src="${esc(avatar)}" alt="" width="32" height="32" loading="lazy">` : ''}${profile ? `<a href="${profile}">${esc(name(c))}</a>` : `<span>${esc(name(c))}</span>`}${when.short ? `<time datetime="${esc(c.created_at)}" title="${esc(when.full)}">${esc(when.short)}</time>` : ''}</header>${target}${gone ? '<p>Comment removed</p>' : `<p>${esc(c.message || '')}</p>${attachments(c)}`}${controls}${validReply === id ? `<div data-ovc-composer-slot>${composer(id)}</div>` : ''}${replies}</article>`;
    };
    const hasReplySlot = validReply && comments.some((c) => String(c.id) === validReply || (validExpanded === String(c.id) && Array.isArray(expandedReplies) ? expandedReplies : c.replies || []).some((r) => String(r.id) === validReply));
    // Top and Newest only when there is something to put in order.
    const order = comments.length < 2 && !(answer && answer.next_cursor) ? '' : `<nav class="ovc-order" aria-label="Comment order">${[['top', 'Top'], ['new', 'Newest']].map(([key, label]) => `<a class="ovk-btn ovk-btn--quiet${sort === key ? ' is-active' : ''}" href="${query(base, key)}"${sort === key ? ' aria-current="page"' : ''} data-ovc-order>${label}</a>`).join('')}</nav>`;
    const next = answer && answer.next_cursor ? `<a class="ovk-btn ovk-btn--quiet ovc-more" href="${query(base, sort, { after: answer.next_cursor })}" data-ovc-order>More comments</a>` : '';
    return `<section class="ovc-thread" id="comments" data-ovc-thread><div class="ovc-head"><h2>Comments</h2>${order}</div>${error ? `<p role="alert">${esc(error)}</p>` : ''}${!hasReplySlot ? `<div data-ovc-composer-slot>${composer()}</div>` : ''}${comments.length ? `<div class="ovc-list">${comments.map((c) => comment(c)).join('')}</div>` : (signedIn ? '<p class="ovc-none">Be the first to comment.</p>' : '')}${next}${threadUrl ? `<p class="ovc-community"><a href="${esc(threadUrl)}">Discuss on OpenVibe.Community</a></p>` : ''}</section>`;
}

module.exports = { renderThread, MEDIA_ID, ID };
