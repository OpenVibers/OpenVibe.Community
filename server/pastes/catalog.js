'use strict';

/**
 * Catalog — the site's view over recent PUBLIC pastes.
 *
 * The store knows newest/oldest, a text search and a per-user filter; it does not sort by views or
 * filter by language. This keeps the latest window of public pastes in memory for a short while
 * and answers trending, related, language counts and the views/language browse modes from it.
 * Everything here is read anonymously, so nothing unlisted or private can ever appear on a shared page.
 *
 * The window is kept only LOCAL_TTL_MS — long enough that one page's latest/trending/languages
 * share a single query.
 *
 * Text pastes and images (screenshots) each have their own window too (recentOf): a run of screenshots
 * filled the shared latest 200, and "most viewed", the language list and related pastes then showed no
 * text paste at all ("0 pastes in the latest 200" beside 59 on the newest page).
 */
const source = require('./source');

const WINDOW = 200;             // page cap for one window query
const LOCAL_TTL_MS = 2000;
const PER_PAGE = 24;

// One cached window per (type, from): type 'paste' | 'screenshot' | null (both), from 'people' | 'streams' | 'all'.
const _windows = new Map();     // key → { at, promise, pastes }
// Where a paste comes from: people (written or imported by someone) or streams (OpenVibe.AI's moment pastes from Live).
const FROM = { people: 'people', streams: 'ai', all: undefined };

function _textOnlyPublic(rows) {
    return (rows || []).filter((p) => p && p.slug && (p.visibility === 'public' || p.visibility == null));
}

/** The latest public pastes of one type and origin (cached). Never throws: an unavailable store yields the stale list or []. */
async function windowOf({ type = null, from = 'all' } = {}) {
    const key = `${type || 'any'}:${from}`;
    const now = Date.now();
    const cur = _windows.get(key) || { at: 0, promise: null, pastes: [] };
    if (cur.promise) return cur.promise;
    if (now - cur.at < LOCAL_TTL_MS) return cur.pastes;
    const query = { limit: WINDOW, offset: 0, ...(type ? { type } : {}), ...(FROM[from] ? { origin: FROM[from] } : {}) };
    cur.promise = source.listPastes(query)
        .then((out) => { _windows.set(key, { at: Date.now(), promise: null, pastes: _textOnlyPublic(out && out.pastes) }); return _windows.get(key).pastes; })
        .catch((err) => { console.warn(`[Catalog] recent pastes (${key}) unavailable:`, err.message); _windows.set(key, { at: Date.now() - LOCAL_TTL_MS + 5000, promise: null, pastes: cur.pastes }); return cur.pastes; });
    _windows.set(key, cur);
    return cur.promise;
}

/** The latest public pastes, every type and origin (cached). Never throws. */
const recent = () => windowOf();
/** The latest public pastes of one type, 'paste' (text) or 'screenshot' (cached like recent()). Never throws. */
const recentOf = (type) => windowOf({ type });

function byViews(a, b) { return (b.views || 0) - (a.views || 0) || (b.likes || 0) - (a.likes || 0) || String(b.created_at).localeCompare(String(a.created_at)); }
function byNewest(a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); }

const fromOf = (v) => (Object.prototype.hasOwnProperty.call(FROM, v) ? v : 'all');
async function latest(n = 12, { from = 'all' } = {}) { return (await windowOf({ from: fromOf(from) })).slice().sort(byNewest).slice(0, n); }
async function trending(n = 8, { from = 'all' } = {}) { return (await windowOf({ from: fromOf(from) })).slice().sort(byViews).slice(0, n); }

/** Pastes in the same language first, then the newest, never the paste itself. */
async function related(paste, n = 6) {
    const rows = (await recentOf(paste.type === 'screenshot' ? 'screenshot' : 'paste')).filter((p) => p.slug !== paste.slug);
    const lang = paste.language && paste.language !== 'text' ? paste.language : null;
    const same = lang ? rows.filter((p) => p.language === lang) : [];
    const rest = rows.filter((p) => !same.includes(p));
    return same.concat(rest).slice(0, n);
}

/** [{ language, count }] over the recent window, most common first. */
async function languages() {
    const counts = new Map();
    const [text, images] = await Promise.all([recentOf('paste'), recentOf('screenshot')]);
    for (const p of [...text, ...images]) {
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
    // Whose: people's pastes (the default), the moment pastes from streams, or both.
    const from = ['people', 'streams', 'all'].includes(query.from) ? query.from : 'people';
    // What to list: text pastes (people's default), images (screenshots) or all of them. The moment pastes from streams
    // are screenshots with a caption, so their default is all.
    const type = ['all', 'pastes', 'images'].includes(query.type) ? query.type : (lang === 'image' ? 'images' : from === 'streams' ? 'all' : 'pastes');
    return { q, sort, lang: type === 'images' && lang === 'image' ? '' : lang, page, type, from };
}
const _ofType = (type) => (p) => (type === 'all' ? true : type === 'images' ? p.type === 'screenshot' : p.type !== 'screenshot');

/**
 * Browse: { q, sort: 'new'|'views', lang, page } → { pastes, total, page, pages, perPage, ... }.
 * Newest with no language filter pages straight through the store (its total is exact); the views
 * sort and the language filter are answered from the recent window.
 */
async function browse(query = {}, ctx = {}) {
    const { q, sort, lang, page, type, from } = normalizeBrowseQuery(query);
    const origin = FROM[from] ? { origin: FROM[from] } : {};
    const offset = (page - 1) * PER_PAGE;
    let pastes, total, windowed = false;

    if (sort === 'new' && !lang && type === 'pastes') {
        const out = await source.listPastes({ limit: PER_PAGE, offset, search: q || undefined, type: 'paste', ...origin }, ctx);
        pastes = _textOnlyPublic(out && out.pastes);
        total = Number(out && out.total) || pastes.length;
    } else {
        let rows;
        if (q) {
            const out = await source.listPastes({ limit: WINDOW, offset: 0, search: q, type: 'paste', ...origin }, ctx);
            rows = _textOnlyPublic(out && out.pastes);
        } else if (type === 'all') {
            const [text, images] = await Promise.all([windowOf({ type: 'paste', from }), windowOf({ type: 'screenshot', from })]);
            rows = [...text, ...images];
        } else {
            rows = await windowOf({ type: type === 'images' ? 'screenshot' : 'paste', from });
        }
        rows = rows.filter(_ofType(type));
        if (lang) rows = rows.filter((p) => (p.language || 'text') === lang);
        rows = rows.slice().sort(sort === 'views' ? byViews : byNewest);
        total = rows.length;
        pastes = rows.slice(offset, offset + PER_PAGE);
        windowed = true;
    }
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    return { pastes, total, page, pages, perPage: PER_PAGE, q, sort, lang, type, from, windowed, windowSize: WINDOW };
}

/** For tests and a hot reload after a write. */
function reset() { _windows.clear(); }

module.exports = { recent, recentOf, latest, trending, related, languages, browse, normalizeBrowseQuery, reset, PER_PAGE, WINDOW };
