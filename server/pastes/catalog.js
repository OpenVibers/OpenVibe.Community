'use strict';

/**
 * Catalog — the site's view over recent PUBLIC pastes.
 *
 * Live's list endpoint (Media behind it) knows newest/oldest, a text search and a per-user
 * filter; it does not sort by views or filter by language. This keeps the latest window of
 * public pastes (Media's page cap) in memory for a short while and answers trending,
 * related, language counts and the views/language browse modes from it. Everything here is
 * fetched anonymously, so nothing unlisted or private can ever appear on a shared page.
 */
const live = require('../live-client');

const WINDOW = 200;             // Media's maximum page size
const TTL_MS = 45 * 1000;       // fresh enough for a community feed, cheap enough for Live
const PER_PAGE = 24;

let _recent = { at: 0, promise: null, pastes: [] };

function _textOnlyPublic(rows) {
    return (rows || []).filter((p) => p && p.slug && (p.visibility === 'public' || p.visibility == null));
}

/** The latest public pastes (cached). Never throws — an unreachable Live yields the stale list or []. */
async function recent() {
    const now = Date.now();
    if (_recent.promise) return _recent.promise;
    if (now - _recent.at < TTL_MS) return _recent.pastes;
    _recent.promise = live.listPastes({ limit: WINDOW, offset: 0 })
        .then((out) => { _recent = { at: Date.now(), promise: null, pastes: _textOnlyPublic(out && out.pastes) }; return _recent.pastes; })
        .catch((err) => { console.warn('[Catalog] recent pastes unavailable:', err.message); _recent.promise = null; _recent.at = Date.now() - TTL_MS + 5000; return _recent.pastes; });
    return _recent.promise;
}

function byViews(a, b) { return (b.views || 0) - (a.views || 0) || (b.likes || 0) - (a.likes || 0) || String(b.created_at).localeCompare(String(a.created_at)); }
function byNewest(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }

async function latest(n = 12) { return (await recent()).slice().sort(byNewest).slice(0, n); }
async function trending(n = 8) { return (await recent()).slice().sort(byViews).slice(0, n); }

/** Pastes in the same language first, then the newest, never the paste itself. */
async function related(paste, n = 6) {
    const rows = (await recent()).filter((p) => p.slug !== paste.slug);
    const lang = paste.language && paste.language !== 'text' ? paste.language : null;
    const same = lang ? rows.filter((p) => p.language === lang) : [];
    const rest = rows.filter((p) => !same.includes(p));
    return same.concat(rest).slice(0, n);
}

/** [{ language, count }] over the recent window, most common first. */
async function languages() {
    const counts = new Map();
    for (const p of await recent()) {
        const l = p.type === 'screenshot' ? 'image' : (p.language || 'text');
        counts.set(l, (counts.get(l) || 0) + 1);
    }
    return [...counts.entries()].map(([language, count]) => ({ language, count })).sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
}

function normalizeBrowseQuery(query = {}) {
    const q = String(query.q || '').trim().slice(0, 120);
    const sort = query.sort === 'views' ? 'views' : 'new';
    const lang = String(query.lang || '').trim().toLowerCase().replace(/[^a-z0-9+#.-]/g, '').slice(0, 32);
    const page = Math.max(1, Math.min(parseInt(query.page, 10) || 1, 500));
    return { q, sort, lang, page };
}

/**
 * Browse: { q, sort: 'new'|'views', lang, page } → { pastes, total, page, pages, perPage, ... }.
 * Newest with no language filter pages straight through Live (its total is exact); the views
 * sort and the language filter are answered from the recent window.
 */
async function browse(query = {}, ctx = {}) {
    const { q, sort, lang, page } = normalizeBrowseQuery(query);
    const offset = (page - 1) * PER_PAGE;
    let pastes, total, windowed = false;

    if (sort === 'new' && !lang) {
        const out = await live.listPastes({ limit: PER_PAGE, offset, search: q || undefined, type: 'paste' }, ctx);
        pastes = _textOnlyPublic(out && out.pastes);
        total = Number(out && out.total) || pastes.length;
    } else {
        let rows;
        if (q) {
            const out = await live.listPastes({ limit: WINDOW, offset: 0, search: q, type: 'paste' }, ctx);
            rows = _textOnlyPublic(out && out.pastes);
        } else {
            rows = await recent();
        }
        if (lang) rows = rows.filter((p) => (lang === 'image' ? p.type === 'screenshot' : (p.language || 'text') === lang));
        rows = rows.slice().sort(sort === 'views' ? byViews : byNewest);
        total = rows.length;
        pastes = rows.slice(offset, offset + PER_PAGE);
        windowed = true;
    }
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    return { pastes, total, page, pages, perPage: PER_PAGE, q, sort, lang, windowed, windowSize: WINDOW };
}

/** For tests and a hot reload after a write. */
function reset() { _recent = { at: 0, promise: null, pastes: [] }; }

module.exports = { recent, latest, trending, related, languages, browse, normalizeBrowseQuery, reset, PER_PAGE, WINDOW };
