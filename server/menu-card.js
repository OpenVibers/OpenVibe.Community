'use strict';
// The menu's network card for OpenVibe.Community (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// Community publishes "Hot in the forum": the threads with the most live replies in the last seven days, each
// linking to its thread under /forum/<space>/<thread>. When nothing is hot, the card shows the newest threads in
// public spaces and says so: "New in the forum". The rows come from the forum's own queries over public spaces
// (server/forum/store.js hotThisWeek and recentThreads), so members-only and staff spaces, gated threads and
// deleted posts never reach the card; a thread marked 18+ is left off, because the menu is on every site.
// With no public threads at all the card is still served, with no items, and Network skips it. The file is
// CORS *, cached for five minutes; a failed database keeps the last good card.
const labels = require('./forum/labels');

const BASE = 'https://openvibe.community';
const CARD_ID = 'hot-threads';
const SITE = 'community';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const LIMIT = 5;
const HOT_TITLE = 'Hot in the forum';
const NEW_TITLE = 'New in the forum';

/** Plain words for a card: no markup, no control characters, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The thread's address, the same /forum/<space>/<thread> the forum renders. */
const threadPath = (space, thread) => `/forum/${encodeURIComponent(String(space))}/${encodeURIComponent(String(thread))}`;

/** "just now", "12m ago", "3h ago" or "2d ago" for a thread's own time; empty when unknown. */
function ago(value, now) {
    const at = typeof value === 'number' ? value : Date.parse(String(value || ''));
    if (!Number.isFinite(at)) return '';
    const mins = Math.max(0, Math.floor((now - at) / 60_000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/** A thread the menu may show: public, not deleted, not members-only, not marked 18+. */
function showable(row) {
    if (!row || !row.space_slug || !row.slug) return false;
    if (row.deleted_at || row.members_only_owner) return false;
    if (row.visibility && row.visibility !== 'public') return false;
    return !labels.labelsOf(row).labels.includes('18+');
}

/**
 * The card itself. `rows` are forum.hotThisWeek() rows ({ title, slug, space_slug, replies, last_at }) or
 * forum.newestPublic() rows when nothing is hot ({ title, slug, space_slug, author, created_at }). `newest`
 * says which list it is, so the title and the meta line match what the reader is looking at.
 */
function cardFrom(rows, at = Date.now(), { newest = false } = {}) {
    const items = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!showable(row)) continue;
        const title = plain(row.title, 80);
        if (!title) continue;
        let meta;
        if (newest) {
            const who = row.author ? plain(row.author.display_name || row.author.username, 60) : '';
            meta = [who || plain(row.space_slug, 60), ago(row.created_at, at)].filter(Boolean).join(' · ');
        } else {
            const n = Number(row.replies) || 0;
            if (n < 1) continue;
            meta = [plain(row.space_slug, 60), `${n.toLocaleString('en-US')} ${n === 1 ? 'reply' : 'replies'}`, ago(row.last_at, at)].filter(Boolean).join(' · ');
        }
        items.push({ title, ...(meta ? { meta: plain(meta, 120) } : {}), url: `${BASE}${threadPath(row.space_slug, row.slug)}` });
        if (items.length >= LIMIT) break;
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: newest ? NEW_TITLE : HOT_TITLE,
        kind: 'rows',
        items,
        more: { label: 'Visit the forum', url: `${BASE}/forum` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/**
 * The route. `load()` returns forum.hotThisWeek() rows; when it has nothing to show, `loadNewest()` returns
 * forum.newestPublic() rows. `now` is injectable for the test.
 */
function createMenuCard({ load, loadNewest = null, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                const hot = cardFrom(await load(), at);
                cached = hot.items.length || !loadNewest ? hot : cardFrom(await loadNewest(), at, { newest: true });
                cachedAt = at;
            } catch {
                // Keep the last good card rather than publish an empty one on a database hiccup.
                if (!cached) { cached = cardFrom([], at); cachedAt = at; }
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    async function handler(_req, res) {
        const body = await card();
        res.set('Cache-Control', 'public, max-age=60')
            .set('Access-Control-Allow-Origin', '*')
            .set('Cross-Origin-Resource-Policy', 'cross-origin')
            .json([body]);
    }

    return { card, handler, cardFrom, cacheMs: CACHE_MS };
}

module.exports = { createMenuCard, cardFrom, showable, threadPath, plain, ago, BASE, CARD_ID, SITE, CARD_TTL_S, LIMIT, HOT_TITLE, NEW_TITLE };
