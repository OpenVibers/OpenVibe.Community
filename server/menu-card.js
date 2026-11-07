'use strict';
// The menu's network card for OpenVibe.Community (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
//
// Community publishes "Hot in the forum": the six threads with the most live replies in the last seven days,
// each linking to its thread under /forum/<space>/<thread>. The rows come from the forum's own query over
// public spaces (server/forum/store.js hotThisWeek), so members-only and staff spaces, gated threads and
// deleted posts never reach the card. With no replies this week the card is still served, with no items, and
// Network skips it. The file is CORS *, cached for five minutes; a failed database keeps the last good card.
const BASE = 'https://openvibe.community';
const CARD_ID = 'hot-threads';
const SITE = 'community';
const CARD_TTL_S = 300;
const CACHE_MS = CARD_TTL_S * 1000;
const LIMIT = 6;

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

/** The card itself. `rows` are forum.hotThisWeek() rows: { title, slug, space_slug, replies }. */
function cardFrom(rows, at = Date.now()) {
    const items = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.space_slug || !row.slug) continue;
        const title = plain(row.title, 80);
        if (!title) continue;
        const n = Number(row.replies) || 0;
        if (n < 1) continue;
        items.push({ title, meta: `${n.toLocaleString('en-US')} ${n === 1 ? 'reply' : 'replies'}`, url: `${BASE}${threadPath(row.space_slug, row.slug)}` });
        if (items.length >= LIMIT) break;
    }
    return {
        id: CARD_ID,
        site: SITE,
        title: 'Hot in the forum',
        kind: 'rows',
        items,
        more: { label: 'Visit the forum', url: `${BASE}/forum` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/** The route. `load` returns forum.hotThisWeek() rows; `now` is injectable for the test. */
function createMenuCard({ load, now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                cached = cardFrom(await load(), at);
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

module.exports = { createMenuCard, cardFrom, threadPath, plain, BASE, CARD_ID, SITE, CARD_TTL_S, LIMIT };
