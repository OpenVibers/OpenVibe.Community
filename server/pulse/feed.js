'use strict';

/**
 * GET /api/v1/feed — the menu's Feed on every OpenVibe site (openvibe-shared ov-home.js feed(): "a real feed… you scroll
 * through easy content… a filter system", the owner, 11-09). One stream, newest first, built from Pulse (every public
 * thing that happens on the network: posts, pastes, statuses, threads, a stream going live, a clip, a video, a picture,
 * a meme, a game, a wiki page, a quest badge, a busy chat hour, a calendar event, the people who joined, an update…)
 * with the network's trending pictures and videos (Network's Frame cards) woven into the first page.
 *
 *   GET /?kind=live|stream|clip|video|pic|post|meme|game|update|wiki|quest|chat|event|member
 *        &site=<source service>&q=<title or text>&following=1&cursor=<opaque>&limit=
 *   → { items: [{ id, kind (live while on air; a go-live that is over is "stream"), url, title, text, at, site, site_name, actor: { name, avatar } | null,
 *                 media: { thumb, ratio, length } | null, counts: { views?, likes?, comments? }, live_now? }], next_cursor }
 *
 * Text only (the client draws every field as text); https links only; nothing from Frame without a picture and a title.
 * following=1 is the signed-in person's Network follows; q searches the card's title and text; counts are Community's
 * own views, likes and comments where it knows them, and {} elsewhere. A live card carries live_now: whether that channel
 * is on Live's live list now. Never one service call per request: the other
 * sites' activity is already in Pulse (server/pulse/sources.js and server/pulse/consumer.js).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, fail, isoTime, sqlTime, encodeCursor } = require('../http/v1');

const KINDS = ['live', 'stream', 'clip', 'video', 'pic', 'post', 'meme', 'game', 'update', 'wiki', 'quest', 'chat', 'event', 'member'];
const SITE_NAMES = { live: 'Live', 'media-hub': 'Video', video: 'Video', pics: 'Pics', meme: 'Meme', games: 'Games', community: 'Community', blog: 'Blog', wiki: 'Wiki', quest: 'Quest', chat: 'Chat', tools: 'Tools', news: 'News', report: 'Report', today: 'Today', network: 'Network' };
const MAX_PAGE_READS = 8;
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
    if (s === 'wiki' || /^(page|revision)$/.test(t)) return 'wiki';
    if (s === 'quest' || /^(badge|completion|quest)$/.test(t)) return 'quest';
    if (s === 'chat' || /^(hour|message|room)$/.test(t)) return 'chat';
    if (s === 'today' || /^(event|calendar)$/.test(t)) return 'event';
    if (s === 'network' || /^(members|member|join)$/.test(t)) return 'member';
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
        text: clean(i.text, 280),
        at: isoTime(i.occurred_at) || i.occurred_at || null,
        site,
        site_name: SITE_NAMES[site] || site.replace(/^app:/, ''),
        actor: a ? { name: clean(a.display_name || a.username || '', 80) || null, avatar: https(a.avatar_url) } : null,
        media: i.picture_url && https(i.picture_url) ? { thumb: https(i.picture_url), ...(i.preview_url && https(i.preview_url) ? { preview: https(i.preview_url) } : {}), ratio: Number(i.media_ratio) > 0 ? Number(i.media_ratio) : 16 / 9, ...(Number(i.media_length) > 0 ? { length: Number(i.media_length) } : {}) } : null,
        counts: {},
        ...(i.label ? { label: i.label } : {}),
    };
}

const svcOf = (i) => String((i.source && i.source.service) || i.source_service || '');
const typeOf = (i) => String((i.source && i.source.type) || i.source_type || '');
const idOf = (i) => String((i.source && i.source.id) || i.source_id || '');

/** Community's own views, likes and comments, in a few batched reads (never one query per card). */
async function countsFor(db, rows) {
    const out = new Map();
    const idsOf = (type) => rows.filter((r) => svcOf(r) === 'community' && typeOf(r) === type).map((r) => idOf(r));
    const key = (type, id) => `${type}:${id}`;
    const n = (v) => Math.max(0, Number(v) || 0);

    const pastes = [...new Set(idsOf('paste'))];
    if (pastes.length) {
        const ph = pastes.map(() => '?').join(', ');
        const [prows, crows] = await Promise.all([
            db.prepare(`SELECT slug, views, likes FROM pastes WHERE slug IN (${ph})`).all(...pastes),
            db.prepare(`SELECT ref_id, comment_count FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'paste' AND ref_id IN (${ph})`).all(...pastes),
        ]);
        const comments = new Map(crows.map((r) => [String(r.ref_id), n(r.comment_count)]));
        for (const r of prows) out.set(key('paste', r.slug), { views: n(r.views), likes: n(r.likes), comments: comments.get(String(r.slug)) || 0 });
    }

    const threadIds = [...new Set([...idsOf('thread'), ...idsOf('status')].filter((x) => /^\d{1,15}$/.test(x)).map(Number))];
    if (threadIds.length) {
        const ph = threadIds.map(() => '?').join(', ');
        const [trows, rrows] = await Promise.all([
            db.prepare(`SELECT id, views, reply_count, score FROM threads WHERE id IN (${ph})`).all(...threadIds),
            db.prepare(`SELECT p.thread_id, COUNT(*) AS n FROM post_reactions r JOIN posts p ON p.id = r.post_id
                        WHERE p.is_opening = 1 AND p.thread_id IN (${ph}) GROUP BY p.thread_id`).all(...threadIds),
        ]);
        const reactions = new Map(rrows.map((r) => [Number(r.thread_id), n(r.n)]));
        for (const r of trows) {
            out.set(key('thread', r.id), { views: n(r.views), likes: n(r.score), comments: n(r.reply_count) });
            out.set(key('status', r.id), { views: n(r.views), likes: reactions.get(Number(r.id)) || 0, comments: n(r.reply_count) });
        }
    }

    const posts = idsOf('post');
    if (posts.length) {
        const ph = posts.map(() => '?').join(', ');
        const [rrows, crows] = await Promise.all([
            db.prepare(`SELECT post_id, COUNT(*) AS n FROM post_reactions WHERE post_id IN (${ph}) GROUP BY post_id`).all(...posts),
            db.prepare(`SELECT ref_id, comment_count FROM comment_threads WHERE ref_service = 'community' AND ref_type = 'post' AND ref_id IN (${ph})`).all(...posts),
        ]);
        const likes = new Map(rrows.map((r) => [String(r.post_id), n(r.n)]));
        const comments = new Map(crows.map((r) => [String(r.ref_id), n(r.comment_count)]));
        for (const id of posts) out.set(key('post', id), { likes: likes.get(id) || 0, comments: comments.get(id) || 0 });
    }
    return out;
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

function createFeedApi({ pulse, viewers, limits, db, networkUrl = 'https://openvibe.network', liveUrl = 'https://openvibe.live', fetchImpl = globalThis.fetch }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    router.use(limits.reads('community.feed.read'));
    const trending = createTrending({ networkUrl, fetchImpl });
    const liveNow = createLiveNow({ liveUrl, fetchImpl });
    // A "went live" item is live now only while that channel is on Live's live list.
    const mark = (cards, live) => cards.forEach((c) => { if (c.kind === 'live') { c.live_now = live.has(channelOf(c.url).toLowerCase()); if (!c.live_now) c.kind = 'stream'; } });

    router.get('/', run(async (req) => {
        const kind = KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
        const site = clean(req.query.site, 40).toLowerCase();
        const q = clean(req.query.q, 80).toLowerCase();
        const following = /^(1|true|yes|on)$/i.test(String(req.query.following || ''));
        const want = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
        if (following && (!req.viewer || req.viewer.kind !== 'user' || !req.viewer.token)) fail(401, 'feed.sign_in_required', 'Sign in to see the people you follow');
        const followed = following ? new Set(await pulse.followedFor(req.viewer)) : null;

        const live = await liveNow();
        // Copy cached trending cards before marking them: a channel can go live again during the cache TTL.
        const extras = !req.query.cursor && !q && !following
            ? (await trending()).map((c) => ({ ...c })) : [];
        mark(extras, live);
        const t = extras.filter((c) => (!kind || c.kind === kind) && (!site || c.site === site));
        // Reserve at most one in four slots for trending, keeping the requested limit for the whole response.
        const pulseWant = want - Math.min(t.length, Math.floor(want / 4));
        const picked = [];
        let cursor = req.query.cursor ? String(req.query.cursor) : '';
        let next = null;
        // A kind, site or word filters Pulse's pages until the page is full (at most eight pages read per call).
        for (let pages = 0; pages < MAX_PAGE_READS && picked.length < pulseWant; pages++) {
            const page = await pulse.list({ after: cursor || undefined, limit: 40 }, req.viewer);
            const rows = page.items || [];
            next = page.next_cursor || null;
            for (let index = 0; index < rows.length; index++) {
                const i = rows[index];
                const actorSubject = i.actor_subject || (i.actor && i.actor.subject) || null;
                if (followed && !(actorSubject && followed.has(actorSubject))) continue;
                const c = card(i);
                mark([c], live);
                if (kind && c.kind !== kind) continue;
                if (site && c.site !== site) continue;
                if (q && !(c.title.toLowerCase().includes(q) || c.text.toLowerCase().includes(q)
                    || String(c.actor && c.actor.name || '').toLowerCase().includes(q)
                    || c.site_name.toLowerCase().includes(q) || c.kind.includes(q))) continue;
                picked.push({ row: i, card: c });
                if (picked.length >= pulseWant) {
                    // Resume after the last consumed row, including when Pulse's final page was only partly read.
                    if (index < rows.length - 1) next = encodeCursor([sqlTime(i.occurred_at), i.id]);
                    break;
                }
            }
            if (!next) break;
            cursor = next;
        }
        const counts = await countsFor(db, picked.map((p) => p.row));
        for (const p of picked) p.card.counts = counts.get(`${typeOf(p.row)}:${idOf(p.row)}`) || {};

        // The first page carries trending pictures and videos, one after every three Pulse items.
        const items = [];
        let k = 0;
        picked.forEach((p, n) => {
            items.push(p.card);
            if ((n + 1) % 3 === 0 && k < Math.min(t.length, Math.floor(want / 4))) items.push(t[k++]);
        });
        while (items.length < want && k < t.length) items.push(t[k++]);
        return { items, next_cursor: next };
    }));
    router.get('/search', run(async (req) => {
        const q = clean(req.query.q, 80).toLowerCase();
        if (!q) fail(400, 'feed.search_required', 'Enter a search term');
        const page = await pulse.list({ limit: 100 }, req.viewer);
        let rows = (page.items || []).map((row) => ({ row, item: card(row) }));
        const kindMatch = /\b(clips?|videos?|photos?|pics?|posts?|streams?|live|games?|updates?)\b/.exec(q);
        const kind = kindMatch && ({ clip: 'clip', clips: 'clip', video: 'video', videos: 'video', photo: 'pic', photos: 'pic', pic: 'pic', pics: 'pic', post: 'post', posts: 'post', stream: 'stream', streams: 'stream', live: 'live', game: 'game', games: 'game', update: 'update', updates: 'update' })[kindMatch[1]];
        const today = /\btoday\b/.test(q);
        const words = q.replace(/\b(clips?|videos?|photos?|pics?|posts?|streams?|live|games?|updates?|from|today|new)\b/g, '').trim();
        if (kind) rows = rows.filter(({ item }) => item.kind === kind || (kind === 'stream' && item.kind === 'live'));
        if (today) { const day = new Date().toISOString().slice(0, 10); rows = rows.filter(({ item }) => String(item.at || '').slice(0, 10) === day); }
        if (words) rows = rows.filter(({ item }) => [item.title, item.text, item.site_name, item.kind, item.actor && item.actor.name].some((v) => String(v || '').toLowerCase().includes(words)));
        return { items: rows.slice(0, 40).map(({ item }) => item), next_cursor: null };
    }));
    router.get('/examples', run(async () => {
        const page = await pulse.list({ limit: 100 });
        const cards = (page.items || []).map(card);
        const examples = [];
        const add = (text, reason) => { if (!examples.some((x) => x.text === text)) examples.push({ text, reason }); };
        const actors = new Map();
        for (const c of cards) {
            if (c.actor && c.actor.name) actors.set(c.actor.name, (actors.get(c.actor.name) || 0) + 1);
        }
        for (const [name] of actors) add(name, 'person');
        for (const kind of [...new Set(cards.map((c) => c.kind))]) add(`new ${kind === 'pic' ? 'photos' : `${kind}s`}`, 'kind');
        add('clips from today', 'date and kind');
        return { examples: examples.slice(0, 8) };
    }));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createFeedApi, kindOf, card, countsFor, channelOf, createLiveNow };
