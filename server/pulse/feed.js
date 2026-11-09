'use strict';

/**
 * GET /api/v1/feed — the menu's Feed on every OpenVibe site (openvibe-shared ov-home.js feed(): "a real feed… you scroll
 * through easy content… a filter system", the owner, 11-09). One stream, newest first, built from Pulse (every public
 * thing that happens on the network: posts, pastes, statuses, threads, a stream going live, a clip, a video, a picture,
 * a meme, a game, a wiki page, a quest badge, a busy chat hour, a calendar event, the people who joined, an update…)
 * with the network's trending pictures and videos (Network's Frame cards) woven into the first page.
 *
 *   GET /?kind=live|clip|video|pic|post|meme|game|update|wiki|quest|chat|event|member
 *        &site=<source service>&q=<title or text>&following=1&cursor=<opaque>&limit=
 *   → { items: [{ id, kind, url, title, text, at, site, site_name, actor: { name, avatar } | null,
 *                 media: { thumb, ratio, length } | null, counts: { views?, likes?, comments? } }], next_cursor }
 *
 * Text only (the client draws every field as text); https links only; nothing from Frame without a picture and a title.
 * following=1 is the signed-in person's Network follows; q searches the card's title and text; counts are Community's
 * own views, likes and comments where it knows them, and {} elsewhere. Never one service call per request: the other
 * sites' activity is already in Pulse (server/pulse/sources.js and server/pulse/consumer.js).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, fail, isoTime } = require('../http/v1');

const KINDS = ['live', 'clip', 'video', 'pic', 'post', 'meme', 'game', 'update', 'wiki', 'quest', 'chat', 'event', 'member'];
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
        media: i.picture_url && https(i.picture_url) ? { thumb: https(i.picture_url), ratio: 16 / 9 } : null,
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

function createFeedApi({ pulse, viewers, limits, db, networkUrl = 'https://openvibe.network', fetchImpl = globalThis.fetch }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    router.use(limits.reads('community.feed.read'));
    const trending = createTrending({ networkUrl, fetchImpl });

    router.get('/', run(async (req) => {
        const kind = KINDS.includes(String(req.query.kind || '')) ? String(req.query.kind) : '';
        const site = clean(req.query.site, 40).toLowerCase();
        const q = clean(req.query.q, 80).toLowerCase();
        const following = /^(1|true|yes|on)$/i.test(String(req.query.following || ''));
        const want = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 40);
        if (following && (!req.viewer || req.viewer.kind !== 'user' || !req.viewer.token)) fail(401, 'feed.sign_in_required', 'Sign in to see the people you follow');
        const followed = following ? new Set(await pulse.followedFor(req.viewer)) : null;

        const picked = [];
        let cursor = req.query.cursor ? String(req.query.cursor) : '';
        let next = null;
        // A kind, site or word filters Pulse's pages until the page is full (at most eight pages read per call).
        for (let pages = 0; pages < MAX_PAGE_READS && picked.length < want; pages++) {
            const page = await pulse.list({ after: cursor || undefined, limit: 40 }, req.viewer);
            for (const i of page.items || []) {
                const actorSubject = i.actor_subject || (i.actor && i.actor.subject) || null;
                if (followed && !(actorSubject && followed.has(actorSubject))) continue;
                const c = card(i);
                if (kind && c.kind !== kind) continue;
                if (site && c.site !== site) continue;
                if (q && !(c.title.toLowerCase().includes(q) || c.text.toLowerCase().includes(q))) continue;
                picked.push({ row: i, card: c });
                if (picked.length >= want) break;
            }
            next = page.next_cursor || null;
            if (!next) break;
            cursor = next;
        }
        const counts = await countsFor(db, picked.map((p) => p.row));
        for (const p of picked) p.card.counts = counts.get(`${typeOf(p.row)}:${idOf(p.row)}`) || {};

        // The first page carries the network's trending pictures and videos, one after every three items.
        if (!req.query.cursor && !q && !following) {
            const t = (await trending()).filter((x) => (!kind || x.kind === kind) && (!site || x.site === site));
            if (t.length) {
                const woven = [];
                let k = 0;
                picked.forEach((p, n) => { woven.push(p.card); if ((n + 1) % 3 === 0 && k < t.length) woven.push(t[k++]); });
                while (woven.length < want && k < t.length) woven.push(t[k++]);
                return { items: woven, next_cursor: next };
            }
        }
        return { items: picked.map((p) => p.card), next_cursor: next };
    }));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createFeedApi, kindOf, card, countsFor };
