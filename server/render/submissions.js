'use strict';

/**
 * Submission pages (server/submissions has the rules): the list with the submit form, one
 * submission, and the moderators' review queue. Filters and paging are links and every action is
 * a plain form post, so all of it works without JavaScript.
 */
const seo = require('../seo');
const { renderPage, abs } = require('./layout');
const { escapeHtml: esc } = require('./highlight');
const { renderMarkdown, markdownToText } = require('./markdown');
const { timeTag } = require('./pages');
const { who } = require('./forum');

const KIND_LABELS = { clip: 'Clip', art: 'Art', idea: 'Idea', report: 'Report' };
const STATUS_LABELS = { pending: 'Pending review', accepted: 'Accepted', rejected: 'Not accepted', withdrawn: 'Withdrawn' };

const listHref = ({ kind = '', mine = false, after = null } = {}, path = '/submissions') => {
    const q = new URLSearchParams();
    if (kind) q.set('kind', kind);
    if (mine) q.set('mine', '1');
    if (after) q.set('after', after);
    const s = q.toString();
    return `${path}${s ? `?${s}` : ''}`;
};

const kindBadge = (s) => `<span class="badge">${esc(KIND_LABELS[s.kind] || s.kind)}</span>`;
const statusBadge = (s) => (s.status === 'accepted' ? '' : ` <span class="badge">${esc(STATUS_LABELS[s.status] || s.status)}</span>`);

function itemHtml(s) {
    return `<li class="pulse-item">
    ${kindBadge(s)}
    <div class="pulse-main">
      <a class="thread-title" href="${esc(s.page_url)}">${esc(s.title)}</a>${statusBadge(s)}
      <p class="thread-meta">${who(s.author)} <span class="sep">·</span> ${timeTag(s.created_at)}</p>
    </div>
  </li>`;
}

function listBlock(items, { empty, prev, next }) {
    return `${items.length ? `<ol class="thread-list pulse-list">${items.map(itemHtml).join('')}</ol>` : `<p class="empty">${esc(empty)}</p>`}
  ${prev || next ? `<nav class="pager" aria-label="Pages">${prev ? `<a href="${esc(prev)}"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i> Newest</a>` : '<span></span>'}<span></span>${next ? `<a rel="next" href="${esc(next)}">Older <i class="fa-solid fa-chevron-right" aria-hidden="true"></i></a>` : '<span></span>'}</nav>` : ''}`;
}

function submitForm({ user, values = {}, error = null }) {
    if (!user) return `<p class="alert"><a href="/auth/login?next=${encodeURIComponent('/submissions')}">Sign in with your OpenVibe account</a> to send a clip, art, an idea or a report. Reading needs no account.</p>`;
    const kinds = Object.entries(KIND_LABELS).map(([id, label]) => `<option value="${id}"${values.kind === id ? ' selected' : ''}>${label}</option>`).join('');
    return `<form class="paste-form" method="post" action="/submissions" id="submit">
  <h2>Submit something</h2>
  ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
  <label class="field"><span>Kind</span><select name="kind" required>${kinds}</select></label>
  <label class="field"><span>Title</span><input type="text" name="title" maxlength="200" required value="${esc(values.title || '')}"></label>
  <label class="field"><span>Link (a clip, a picture, anything with an address)</span><input type="url" name="url" maxlength="2000" value="${esc(values.url || '')}" placeholder="https://"></label>
  <label class="field"><span>Description (Markdown)</span><textarea name="body" rows="8" maxlength="10000">${esc(values.body || '')}</textarea></label>
  <div class="form-actions">
    <button class="btn btn-primary" type="submit"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> Submit for review</button>
    <span class="muted small">Sending as <strong>${esc(user.display_name || user.username || 'you')}</strong>. Moderators review it before it is public. By submitting you agree to the <a href="/terms">rules</a>.</span>
  </div>
</form>`;
}

/** GET /submissions — accepted ones (or ?mine=1, your own), the submit form when signed in. */
function submissionsPage({ items, kind = '', mine = false, after = null, nextCursor = null, user = null, moderator = false, values = {}, error = null }) {
    const tabs = [['', 'Everything'], ...Object.entries(KIND_LABELS)].map(([id, label]) => `<a class="tab${id === kind ? ' active' : ''}" href="${esc(listHref({ kind: id, mine }))}"${id === kind ? ' aria-current="page"' : ''}>${label}</a>`).join('');
    const links = user ? `<p class="muted small">${mine ? '<a href="/submissions">All accepted submissions</a>' : '<a href="/submissions?mine=1">Your submissions</a>'}${moderator ? ' · <a href="/submissions/review">Review queue</a>' : ''}</p>` : '';
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span aria-current="page">Submissions</span></nav>
  <h1>${mine ? 'Your submissions' : 'Submissions'}</h1>
  <p class="muted">Clips, art, ideas and reports from the people of OpenVibe. Anyone signed in can submit; moderators review each one, and what they accept appears here and in <a href="/pulse">Pulse</a>.</p>
  ${links}
</header>
<nav class="tabs sort-tabs" aria-label="Filter by kind">${tabs}</nav>
<section data-results>
  ${listBlock(items, { empty: mine ? 'You have not submitted anything yet.' : 'Nothing accepted yet.', prev: after ? listHref({ kind, mine }) : null, next: nextCursor ? listHref({ kind, mine, after: nextCursor }) : null })}
</section>
${submitForm({ user, values, error })}`;
    return renderPage({
        title: mine ? 'Your submissions' : `Submissions${kind ? ` — ${KIND_LABELS[kind]}` : ''}`,
        description: 'Clips, art, ideas and reports from the people of OpenVibe, reviewed by the community\'s moderators.',
        canonicalPath: listHref({ kind, after }),
        robots: mine || after ? 'noindex,follow' : 'index,follow',
        active: 'submissions',
        jsonLd: [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Submissions', url: '/submissions' }])],
        body,
    });
}

/** GET /submissions/:slug */
function submissionPage({ submission: s, user = null, error = null }) {
    const link = s.url ? `<p><a class="btn" href="${esc(s.url)}" rel="nofollow ugc noopener" target="_blank"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> Open the link</a> <span class="muted small">${esc(s.url)}</span></p>` : '';
    const media = s.media_ref ? `<p class="muted small">OpenVibe.Media object <code>${esc(s.media_ref)}</code></p>` : '';
    const review = s.status !== 'pending' && (s.review_note || s.reviewer)
        ? `<aside class="alert"><strong>${esc(STATUS_LABELS[s.status])}</strong>${s.reviewer ? ` by ${who(s.reviewer)}` : ''}${s.reviewed_at ? ` · ${timeTag(s.reviewed_at)}` : ''}${s.review_note ? `<p>${esc(s.review_note)}</p>` : ''}</aside>` : '';
    const withdraw = s.can && s.can.withdraw ? `<form method="post" action="/submissions/${esc(s.slug)}/withdraw" class="inline-form"><button class="btn" type="submit">Withdraw</button></form>` : '';
    const reviewForm = s.can && s.can.review ? `<form class="paste-form" method="post" action="/submissions/${esc(s.slug)}/review">
  <h2>Review</h2>
  <label class="field"><span>Note to the author (optional)</span><textarea name="note" rows="3" maxlength="1000"></textarea></label>
  <div class="form-actions">
    <button class="btn btn-primary" type="submit" name="decision" value="accept">Accept</button>
    <button class="btn" type="submit" name="decision" value="reject">Reject</button>
  </div>
</form>` : '';
    const body = `
<article>
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/submissions">Submissions</a> › <span aria-current="page">${esc(s.title)}</span></nav>
  <h1>${esc(s.title)}</h1>
  <p class="thread-meta">${kindBadge(s)}${statusBadge(s)} ${who(s.author)} <span class="sep">·</span> ${timeTag(s.created_at)}</p>
</header>
${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
${review}
${link}${media}
${s.body ? `<div class="md">${renderMarkdown(s.body)}</div>` : ''}
${withdraw}
</article>
${reviewForm}`;
    const accepted = s.status === 'accepted';
    const description = markdownToText(s.body || '').replace(/\s+/g, ' ').trim().slice(0, 200) || `${KIND_LABELS[s.kind]} submitted to OpenVibe.Community.`;
    return renderPage({
        title: s.title,
        description,
        canonicalPath: s.page_url,
        // Only accepted submissions are public pages.
        robots: accepted ? 'index,follow' : 'noindex,nofollow',
        ogType: 'article',
        active: 'submissions',
        published: s.created_at,
        modified: s.updated_at,
        jsonLd: accepted ? [seo.breadcrumbLd([{ name: 'Home', url: '/' }, { name: 'Submissions', url: '/submissions' }, { name: s.title, url: abs(s.page_url) }])] : [],
        body,
    });
}

/** GET /submissions/review — what is waiting for a moderator, oldest pages behind "Older". */
function reviewQueuePage({ items, after = null, nextCursor = null }) {
    const body = `
<header class="page-head">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/submissions">Submissions</a> › <span aria-current="page">Review queue</span></nav>
  <h1>Review queue</h1>
  <p class="muted">Submissions waiting for a decision, newest first. Open one to accept or reject it.</p>
</header>
<section data-results>
  ${listBlock(items, { empty: 'Nothing is waiting for review.', prev: after ? '/submissions/review' : null, next: nextCursor ? listHref({ after: nextCursor }, '/submissions/review') : null })}
</section>`;
    return renderPage({ title: 'Review queue', description: 'Submissions waiting for review.', canonicalPath: '/submissions/review', robots: 'noindex,nofollow', active: 'submissions', footerVariant: 'compact', body });
}

module.exports = { submissionsPage, submissionPage, reviewQueuePage, KIND_LABELS, STATUS_LABELS };
