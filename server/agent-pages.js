'use strict';
// The Markdown twins of openvibe.community's public pages (openvibe-shared/agent-layer): the home,
// /pastes and a paste. The bodies come from the same page builders the HTML routes use (render/pages.js,
// called through app.js's views with the anonymous viewer and noView), so a twin cannot drift from its
// page and never carries a signed-in person's view. A pasted twin carries the paste's text as prose and
// its comments as the page's threaded comment list.
//
// A private, deleted, burned or missing paste answers 404 and has no twin; a burn-after-read paste is
// never consumed by a twin (app.js checks before the read).
const TWIN_PATH_RE = /^\/(?:pastes|p\/[^/]+)?$/;

function createAgentPages({ views }) {
    async function renderPublicPage(path, { query } = {}) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (!TWIN_PATH_RE.test(p)) return null;
        const q = Object.fromEntries(new URLSearchParams(query ? query.toString() : ''));
        let html;
        if (p === '/') html = await views.home();
        else if (p === '/pastes') html = await views.browse(q);
        else {
            let slug;
            try { slug = decodeURIComponent(p.slice(3)); } catch { return null; }
            const out = await views.paste(slug, q);
            if (!out || out.status !== 200) return null;
            html = out.body;
        }
        return html ? { html } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages, TWIN_PATH_RE };
