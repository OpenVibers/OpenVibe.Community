'use strict';

/**
 * Community's public activity, read directly from its own tables.
 *
 * This is what the one feed (OpenVibe.Network server/feed/) polls: posts, pastes, accepted submissions
 * and their counts, each with the public link, the person and when it happened. There is no Pulse
 * store and no collector: Pulse reads the Network feed now, and this read is Community's public API
 * for its own rows. Only public things leave here: a private or members-only row is filtered in SQL.
 *
 * GET /api/v1/activity?since=<ISO>&limit=   → { items: [{ service, type, id, title, text, url, actor,
 *   origin, at, kind, picture_url, media_ratio, counts }] }
 *
 * `at` is ISO; `id` is the row's own stable id (a paste slug, a thread/post/submission id), so the
 * Network feed keys the same source item across restarts. No body is ever longer than the item shape:
 * text is capped at 280 on one line.
 */
const { sqlTime } = require('../http/v1');

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href.slice(0, 2000) : null; } catch { return null; } };
const iso = (v) => {
    if (v == null || v === '') return null;
    const s = String(v);
    const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const n = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
/** A camera's file name is not a title: "1000012166" or "IMG_1234" is what the picture was called on
 *  the phone, not what it is (the owner, 11-13). */
const CAMERA_NAME = /^(?:\d{3,}|img[-_ ]?\d+|dsc[-_ ]?\d+|pxl[-_ ]?\d+|image[-_ ]?\d+)(?:\.(?:jpe?g|png|webp|gif|heic|heif))?$/i;

/** The title a picture carries in the feed: its caption's first words when the title is a camera's file
 *  name, "A picture" when it has no caption, and the title itself when the person wrote one. */
function pictureTitle(title, content) {
    const name = String(title == null ? '' : title).trim();
    if (!CAMERA_NAME.test(name)) return null;
    const caption = String(content == null ? '' : content).replace(/\s+/g, ' ').trim();
    if (!caption) return 'A picture';
    if (caption.length <= 120) return caption;
    const words = caption.split(' ').slice(0, 10).join(' ');
    return words.length > 120 ? `${words.slice(0, 117).trim()}…` : words;
}
const counts = (c) => {
    const out = {};
    for (const k of ['views', 'likes', 'comments']) if (n(c[k]) || c[k] === 0) out[k] = n(c[k]);
    return out;
};

function createActivity({ db, config = {} } = {}) {
    const base = String(config.baseUrl || 'https://openvibe.community').replace(/\/+$/, '');

    async function pastes(since, limit) {
        const rows = await db.prepare(`SELECT p.slug, p.title, p.content, p.origin, p.type, p.screenshot_url, p.views, p.likes, p.created_at,
                p.owner_subject,
                ct.comment_count
            FROM pastes p
            LEFT JOIN comment_threads ct ON ct.ref_service = 'community' AND ct.ref_type = 'paste' AND ct.ref_id = p.slug
            WHERE p.visibility = 'public' AND p.deleted_at IS NULL AND COALESCE(p.is_nsfw, 0) = 0
              AND COALESCE(p.burn_after_read, 0) = 0 AND p.origin = 'user' AND p.created_at >= ?
            ORDER BY p.created_at DESC LIMIT ?`).all(since, limit);
        return rows.map((p) => {
            const pic = p.type === 'screenshot' || !!p.screenshot_url;
            // The person's own title, or the caption's first words when the title is a camera's file name.
            const title = pic ? pictureTitle(p.title, p.content) : null;
            return {
                service: 'community', type: 'paste', id: p.slug,
                title: title || clean(p.title, 300) || (pic ? 'A picture' : 'A paste'), text: clean(p.content, 280),
                url: `${base}/p/${encodeURIComponent(p.slug)}`,
                // Who posted it: their Network subject, so the feed can name them (feed.item@1 1.1.0).
                actor: p.owner_subject || null, origin: p.origin === 'ai' ? 'ai' : 'user',
                at: iso(p.created_at), kind: pic ? 'pic' : 'paste',
                picture_url: https(p.screenshot_url), media_ratio: null,
                counts: counts({ views: p.views, likes: p.likes, comments: p.comment_count }),
            };
        });
    }

    async function threads(since, limit) {
        const rows = await db.prepare(`SELECT t.id, t.slug AS thread_slug, t.title, t.created_at, t.author_subject, t.origin, t.views, t.score, t.reply_count, s.slug AS space,
                (SELECT b.body_markdown FROM posts b WHERE b.thread_id = t.id AND b.is_opening = 1 AND b.deleted_at IS NULL LIMIT 1) AS opening
            FROM threads t JOIN spaces s ON s.id = t.space_id
            WHERE s.visibility = 'public' AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL
              AND t.deleted_at IS NULL AND t.created_at >= ?
            ORDER BY t.created_at DESC LIMIT ?`).all(since, limit);
        return rows.map((t) => ({
            service: 'community', type: 'thread', id: String(t.id),
            title: clean(t.title, 300) || 'A thread', text: clean(t.opening, 280),
            url: `${base}/forum/${encodeURIComponent(t.space)}/${encodeURIComponent(t.thread_slug || '')}`,
            actor: t.author_subject || null, origin: t.origin === 'ai' ? 'ai' : t.origin === 'system' ? 'system' : 'user',
            at: iso(t.created_at), kind: 'post', picture_url: null, media_ratio: null,
            counts: counts({ views: t.views, likes: t.score, comments: t.reply_count }),
        }));
    }

    async function posts(since, limit) {
        const rows = await db.prepare(`SELECT p.id, p.body_markdown, p.created_at, p.author_subject, p.origin, t.title, t.slug AS thread_slug, s.slug AS space,
                (SELECT COUNT(*) FROM post_reactions r WHERE r.post_id = p.id) AS likes,
                ct.comment_count
            FROM posts p JOIN threads t ON t.id = p.thread_id JOIN spaces s ON s.id = t.space_id
            LEFT JOIN comment_threads ct ON ct.ref_service = 'community' AND ct.ref_type = 'post' AND ct.ref_id = CAST(p.id AS TEXT)
            WHERE p.is_opening = 0 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
              AND s.visibility = 'public' AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL
              AND p.created_at >= ?
            ORDER BY p.created_at DESC LIMIT ?`).all(since, limit);
        return rows.map((p) => ({
            service: 'community', type: 'post', id: String(p.id),
            title: `Re: ${clean(p.title, 280)}`, text: clean(p.body_markdown, 280),
            url: `${base}/forum/${encodeURIComponent(p.space)}/${encodeURIComponent(p.thread_slug || '')}#post-${p.id}`,
            actor: p.author_subject || null, origin: p.origin === 'ai' ? 'ai' : p.origin === 'system' ? 'system' : 'user',
            at: iso(p.created_at), kind: 'post', picture_url: null, media_ratio: null,
            counts: counts({ likes: p.likes, comments: p.comment_count }),
        }));
    }

    async function submissions(since, limit) {
        const rows = await db.prepare(`SELECT slug, title, body, author_subject, reviewed_at, created_at FROM submissions
            WHERE status = 'accepted' AND COALESCE(created_at, '') >= ? ORDER BY created_at DESC LIMIT ?`).all(since, limit);
        return rows.map((s) => ({
            service: 'community', type: 'submission', id: s.slug,
            title: clean(s.title, 300) || 'A submission', text: clean(s.body, 280),
            url: `${base}/submissions/${encodeURIComponent(s.slug)}`,
            actor: s.author_subject || null, origin: 'user', at: iso(s.reviewed_at || s.created_at), kind: 'post',
            picture_url: null, media_ratio: null, counts: {},
        }));
    }

    /** Up to `limit` public items since `since`, newest first. */
    async function list({ since = null, limit = 500 } = {}) {
        const at = since ? Date.parse(since) : NaN;
        const from = Number.isFinite(at) ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) : sqlTime(Date.now() - 30 * 86400000);
        const max = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
        const [a, b, c, d] = await Promise.all([pastes(from, max), threads(from, max), posts(from, max), submissions(from, max)]);
        return [...a, ...b, ...c, ...d]
            .filter((i) => i.at && i.url)
            .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
            .slice(0, max);
    }

    return { list };
}

module.exports = { createActivity, iso, clean, pictureTitle };
