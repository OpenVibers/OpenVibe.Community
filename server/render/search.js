'use strict';
/**
 * /search: Community's threads and pastes, found by OpenVibe.Search (server/search/query.js). Useful
 * without JavaScript; never indexed. When Search does not answer, the page says so and offers the
 * paste filter, which works without it.
 */
const { renderPage } = require('./layout');
const { escapeHtml: esc } = require('./highlight');

// Search escapes the text and adds only <mark>; keep exactly that, whatever arrives.
const snippet = (html) => esc(String(html || '')).replace(/&lt;(\/?)mark&gt;/g, '<$1mark>');
const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return '#'; } };

function resultItem(r) {
    const f = r.facets || {};
    const kind = r.type === 'thread'
        ? `<span class="badge"><i class="fa-solid fa-comments" aria-hidden="true"></i> Thread${f.space ? ` in ${esc(f.space)}` : ''}</span>`
        : `<span class="badge"><i class="fa-solid fa-${f.kind === 'screenshot' ? 'image' : 'code'}" aria-hidden="true"></i> ${f.kind === 'screenshot' ? 'Screenshot' : 'Paste'}${f.syntax && f.syntax !== 'text' ? ` · ${esc(f.syntax)}` : ''}</span>`;
    const when = r.updated_at || r.published_at;
    return `<li class="search-hit">
  <a class="search-title" href="${esc(pathOf(r.canonical_url))}">${esc(r.title || 'Untitled')}</a>
  <div class="search-meta">${kind}${r.authorship === 'ai_generated' ? ' <span class="badge">AI</span>' : ''}${when ? ` <time datetime="${esc(when)}">${esc(String(when).slice(0, 10))}</time>` : ''}</div>
  <p class="search-snippet">${r.snippet_html ? snippet(r.snippet_html) : esc(r.summary || '')}</p>
</li>`;
}

function searchPage({ q = '', type = '', results = [], nextCursor = null, unavailable = false }) {
    const opt = (v, label) => `<option value="${v}"${type === v ? ' selected' : ''}>${label}</option>`;
    const more = nextCursor ? `<nav class="pager"><a class="btn" href="/search?${new URLSearchParams({ q, ...(type ? { type } : {}), cursor: nextCursor })}">More results</a></nav>` : '';
    let section;
    if (unavailable) section = `<p class="empty">Search is not answering right now. <a href="/pastes?q=${encodeURIComponent(q)}">Filter pastes for “${esc(q)}”</a> instead, or try again in a minute.</p>`;
    else if (!q) section = '<p class="empty">Search every public thread and paste on OpenVibe.Community.</p>';
    else if (!results.length) section = `<p class="empty">Nothing public matches “${esc(q)}”.</p>`;
    else section = `<ol class="search-results">${results.map(resultItem).join('\n')}</ol>${more}`;
    const body = `
<header class="page-head">
  <h1>Search</h1>
  <p class="muted">Threads and pastes${q ? ` matching “${esc(q)}”` : ''}. <a href="https://search.openvibe.network/?q=${encodeURIComponent(q)}">Search the whole OpenVibe network</a></p>
</header>
<form class="filters" method="get" action="/search" role="search">
  <label class="search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" name="q" value="${esc(q)}" placeholder="Search threads and pastes" aria-label="Search threads and pastes" maxlength="200" autofocus></label>
  <label>Show <select name="type">${opt('', 'Everything')}${opt('thread', 'Threads')}${opt('paste', 'Pastes')}</select></label>
  <button class="btn" type="submit">Search</button>
</form>
<section id="results">${section}</section>`;
    return renderPage({
        title: q ? `Search: ${q}` : 'Search',
        description: 'Search every public thread and paste on OpenVibe.Community.',
        canonicalPath: '/search',
        robots: 'noindex,follow',
        active: 'search',
        body,
    });
}

module.exports = { searchPage, resultItem };
