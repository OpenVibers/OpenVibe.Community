'use strict';

/**
 * GET /api/v1/feed — the menu's Feed on every OpenVibe site (openvibe-shared ov-home.js feed(): "a real feed… you scroll
 * through easy content… a filter system", the owner, 11-09). One stream, newest first, built from Pulse (every public
 * thing that happens on the network: posts, pastes, statuses, threads, a stream going live, a clip, a video, a picture,
 * a meme, an update…) with the network's trending pictures and videos (Network's Frame cards) woven into the first page.
 *
 *   GET /?kind=live|clip|video|pic|post|meme|game|update&cursor=<opaque>&limit=   anyone (the signed-in person too)
 *   → { items: [{ id, kind (live while on air; a go-live that is over is "stream"), url, title, text, at, site, site_name, actor: { name, avatar } | null,
 *                 media: { thumb, ratio, length } | null, counts: {}, live_now? }], next_cursor }   live_now: on Live's live list now
 *
 * Text only (the client draws every field as text); https links only; nothing from Frame without a picture and a title.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run } = require('../http/v1');

const KINDS = ['live', 'clip', 'video', 'pic', 'post', 'meme', 'game', 'update'];
const SITE_NAMES = { live: 'Live', 'media-hub': 'Video', video: 'Video', pics: 'Pics', meme: 'Meme', games: 'Games', community: 'Community', blog: 'Blog', wiki: 'Wiki', quest: 'Quest', chat: 'Chat', tools: 'Tools', news: 'News', report: 'Report' };
const https = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

/** What a Pulse item is, as a card. */
function kindOf(i) {
    const s = String((i.source && i.source.service) || '');
    const t = String((i.source && i.source.type) || '');
    if (/^(live|stream|went_live|broadcast)$/.test(t) || (s === 'live' && /\b(went live|is live|live now)\b/i.test(i.title || ''))) return 'live';
    if (t === 'clip' || t === 'moment') return 'clip';
    if (/^(vod|video|recording|upload)$/.test(t) || s === 'media-hub' || s === 'video') return 'video';
    if (/^(pic|picture|image|photo)$/.test(t) || s === 'pics') return 'pic';
    if (s === 'meme' || t === 'meme') return 'meme';
    if (s === 'games' || /^(game|world|level)$/.test(t)) return 'game';
    if (s === 'blog' || /^(devblog|update|release|changelog)$/.test(t)) return 'update';
    return 'post';
}

function card(i) {
    const site = String((i.source && i.source.service) || 'community');
    const a = i.actor;
    return {
        id: `p:${i.id}`,
        kind: kindOf(i),
        url: https(i.url) || i.url,
        title: clean(i.title, 300),
        text: '',
        at: i.occurred_at || null,
        site,
        site_name: SITE_NAMES[site] || site.replace(/^app:/, ''),
        actor: a ? { name: clean(a.display_name || a.username || '', 80) || null, avatar: https(a.avatar_url) } : null,
        media: i.picture_url && https(i.picture_url) ? { thumb: https(i.picture_url), ratio: 16 / 9 } : null,
        counts: {},
        ...(i.label ? { label: i.label } : {}),
    };
}

/** The network's trending cards with pictures (Frame), as feed items: woven into the first page, cached five minutes. */
function createTrending({ networkUrl, fetchImpl }) {
    let cache = null; let at = 0;
    const SITE_KIND = { 'media-hub': 'video', video: 'video', live: 'live', pics: 'pic', meme: 'meme', games: 'game' };
    return async function trending() {
        if (cache && Date.now() - at < 5 * 60_000) return cache;
        try {
            const r = await fetchImpl(`${networkUrl}/api/frame?v=2`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            const f = r.ok ? await r.json() : null;
            const out = [];
            for (const c of (f && Array.isArray(f.cards) ? f.cards : [])) {
                const kind = SITE_KIND[c && c.site];
                if (!kind || !Array.isArray(c.items)) continue;
                for (const x of c.items.slice(0, 4)) {
                    const url = https(x && x.url); const thumb = https(x && x.image && x.image.src);
                    if (!url || !thumb || !x.title) continue;
                    out.push({ id: `t:${c.site}:${url}`, kind, url, title: clean(x.title, 200), text: clean(x.meta, 160), at: null, site: c.site,
                        site_name: SITE_NAMES[c.site] || c.site, actor: null, media: { thumb, ratio: 16 / 9 }, counts: {}, label: 'Trending' });
                }
            }
            cache = out; at = Date.now();
        } catch { cache = cache || []; }
        return cache;
    };
}

/** Who is live on Live right now (GET /api/streams, cached a minute): a "went live" card says LIVE only for them. */
function createLiveNow({ liveUrl, fetchImpl }) {
    let cache = new Set(); let at = 0;
    return async function liveNow() {
        if (Date.now() - at < 60_000) return cache;
        at = Date.now();
        try {
            const r = await fetchImpl(`${liveUrl}/api/streams`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
            const j = r.ok ? await r.json() : null;
            cache = new Set(((j && j.streams) || []).map((x) => String((x && x.username) || '').toLowerCase()).filter(Boolean));
        } catch { /* keep the last answer */ }
        return cache;
    };
}
const channelOf = (url) => { try { const u = new URL(url); return /(^|\.)openvibe\.live$/.test(u.hostname) ? (/^\/@?([A-Za-z0-9_.-]{1,40})\/?$/.exec(u.pathname) || [])[1] || '' : ''; } catch { return ''; } };

function createFeedApi({ pulse, viewers, limits, networkUrl = 'https://openvibe.network', liveUrl = 'https://openvibe.live', fetchImpl = globalThis.fetch }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    router.use(limits.reads('community.feed.read'));
    const trending = createTrending({ networkUrl, fetchImpl });
    const liveNow = createLiveNow({ liveUrl, fetchImpl });
    // A "went live" item is live now only while that channel is on Live's live list.
    // A go-live that is over is a stream that happened (kind "stream"): clients draw LIVE only on kind "live".
    const mark = (cards, live) => cards.forEach((c) => { if (c.kind === 'live') { c.live_now = live.has(channelOf(c.url).toLowerCase()); if (!c.live_now) c.kind = 'stream'; } });

    router.get('/', run(async (req) => {
        const kind = KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
        const want = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
        const items = [];
        let cursor = req.query.cursor ? String(req.query.cursor) : '';
        let next = null;
        // A kind filters Pulse's pages until the page is full (at most four pages read per call).
        for (let pages = 0; pages < 4 && items.length < want; pages++) {
            const page = await pulse.list({ after: cursor || undefined, limit: 40 }, req.viewer);
            for (const i of page.items || []) { const c = card(i); if (!kind || c.kind === kind) items.push(c); if (items.length >= want) break; }
            next = page.next_cursor || null;
            if (!next) break;
            cursor = next;
        }
        // The first page carries the network's trending pictures and videos, one after every three items.
        if (!req.query.cursor) {
            const t = (await trending()).filter((x) => !kind || x.kind === kind);
            if (t.length) {
                const woven = [];
                let k = 0;
                items.forEach((x, n) => { woven.push(x); if ((n + 1) % 3 === 0 && k < t.length) woven.push(t[k++]); });
                while (woven.length < want && k < t.length) woven.push(t[k++]);
                mark(woven, await liveNow());
                return { items: woven, next_cursor: next };
            }
        }
        mark(items, await liveNow());
        return { items, next_cursor: next };
    }));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createFeedApi, kindOf, card, channelOf };
