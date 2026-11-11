'use strict';

/**
 * Pulse — a read model of public activity across the network, with provenance.
 *
 * Sources:
 *   - Community's own public activity, recorded at write time (the hooks below): new public
 *     pastes written by a person (not burn-after-read, not NSFW), new threads and replies in
 *     public spaces, and submissions when they are accepted. Deletes and visibility changes take items out again, and listItems()
 *     re-checks Community's own items at read time as well.
 *   - Other services, through POST /api/v1/pulse/items with community.pulse.write: an EntityRef
 *     of their own (ref.service must be the calling service), title, url, origin, occurred_at.
 *     Only visibility 'public' is accepted — private or unlisted things never enter Pulse.
 *
 * Provenance (roadmap §33): origin is user | ai | system. AI items are labelled as AI and never
 * carry an actor; system items have none either; user items name the acting person (the JWT
 * subject for Community's own writes, X-OV-Subject for services).
 */
const contracts = require('openvibe-contracts');
const store = require('./store');
const { fail, sqlTime, isoTime, encodeCursor, decodeCursor } = require('../http/v1');
const { createAuthors } = require('../identity/authors');

const ORIGINS = ['user', 'ai', 'system'];
const PAGE = 30;
const FUTURE_SKEW_MS = 5 * 60_000;

/** 'svc:live' → 'live' (the service a client-credentials token belongs to). */
const serviceNameOf = (sub) => String(sub || '').replace(/^(svc|app|mod):/, '');

function createPulse({ db, network = null, config = {}, fetchImpl = globalThis.fetch } = {}) {
    const authors = createAuthors({ db, network });
    const base = (config.baseUrl || '').replace(/\/$/, '');
    let originsCache = { at: 0, list: null };
    const followsCache = new Map();
    const appWrites = new Map();

    async function followedSubjects(v) {
        const cached = followsCache.get(v.subject);
        if (cached && Date.now() - cached.at < 30_000) return cached.ids;
        const ids = [];
        let cursor = null;
        do {
            const url = new URL('/api/v1/me/follows', config.networkInternalUrl);
            url.searchParams.set('type', 'channel');
            url.searchParams.set('limit', '200');
            if (cursor) url.searchParams.set('cursor', cursor);
            const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${v.token}` }, signal: AbortSignal.timeout(5000) });
            if (!res.ok) fail(503, 'pulse.follows_unavailable', 'Could not load your follows');
            const page = await res.json();
            ids.push(...(page.items || []).map((x) => x.target_id));
            cursor = page.next_cursor;
        } while (cursor && ids.length < 5000);
        if (followsCache.size > 1000) followsCache.delete(followsCache.keys().next().value);
        followsCache.set(v.subject, { at: Date.now(), ids });
        return ids;
    }

    /** The feed's short text: the first 280 characters, one line, never a whole post. */
    const feedText = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 280);
    const picture = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

    /** Record one of Community's own items; never lets a Pulse problem fail the write that caused it. */
    async function recordLocal(type, id, { title, path, actor = null, origin = 'user', at = null, text = '', pictureUrl = null }) {
        try {
            const o = ORIGINS.includes(origin) ? origin : 'user';
            await store.upsertItem(db, {
                source_service: 'community', source_type: type, source_id: String(id),
                title: String(title || 'Untitled').slice(0, 300), url: `${base}${path}`,
                actor_subject: o === 'user' ? actor : null, origin: o, occurred_at: at || sqlTime(),
                text: feedText(text), picture_url: picture(pictureUrl),
            });
        } catch (err) { console.warn('[Pulse] record failed:', err.message); }
    }
    async function forgetLocal(type, id) {
        try { await store.removeItem(db, 'community', type, id); } catch (err) { console.warn('[Pulse] remove failed:', err.message); }
    }

    function shape(i, projections) {
        const ai = i.origin === 'ai';
        const actor = ai || i.origin === 'system' ? null : authors.author(i.actor_subject, 'user', projections);
        return {
            id: i.id,
            source: { service: i.source_service, type: i.source_type, id: i.source_id },
            title: i.title,
            url: i.url,
            origin: i.origin,
            label: ai ? 'AI' : (i.origin === 'system' ? 'System' : null),
            ...(i.source_service.startsWith('app:') ? { via: `via ${i.app_name || i.source_service.slice(4)}` } : {}),
            ...(i.picture_url ? { picture_url: i.picture_url } : {}),
            ...(i.preview_url ? { preview_url: i.preview_url } : {}),
            ...(i.media_ratio ? { media_ratio: i.media_ratio } : {}),
            ...(i.media_length ? { media_length: i.media_length } : {}),
            ...(i.text ? { text: i.text } : {}),
            actor,
            occurred_at: isoTime(i.occurred_at),
        };
    }

    return {
        ORIGINS,
        forgetLocal,
        /** The channels the signed-in person follows (Network), for the feed's following filter. */
        async followedFor(v) {
            if (!v || v.kind !== 'user' || !v.token) return [];
            return await followedSubjects(v);
        },
        async statusCreated(thread, text, actor, pictureUrl = null) {
            await recordLocal('status', thread.id, { title: text.slice(0, 300), path: `/forum/status/${thread.slug}`,
                actor, origin: 'user', at: thread.created_at, text, pictureUrl });
        },

        // ── hooks for Community's own writes ─────────────────
        async pasteCreated(p) {
            if (!p || p.visibility !== 'public' || p.origin !== 'user' || Number(p.burn_after_read) || Number(p.is_nsfw)) return;
            await recordLocal('paste', p.slug, { title: p.title, path: `/p/${encodeURIComponent(p.slug)}`, actor: p.owner_subject, origin: 'user', at: p.created_at,
                text: p.content, pictureUrl: p.screenshot_url });
        },
        async pasteChanged(p) {
            if (!p) return;
            if (p.deleted_at || p.visibility !== 'public' || Number(p.is_nsfw)) await forgetLocal('paste', p.slug);
        },
        async pasteGone(slug) { await forgetLocal('paste', slug); },
        async threadCreated(thread, space, extra = {}) {
            if (!thread || !space || space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner) return;
            await recordLocal('thread', thread.id, {
                title: thread.title, path: `/forum/${space.slug}/${thread.slug}`,
                actor: thread.author_subject, origin: thread.origin === 'ai' ? 'ai' : (thread.origin === 'system' ? 'system' : 'user'), at: thread.created_at,
                text: extra.text, pictureUrl: extra.picture,
            });
        },
        async postCreated(post, thread, space, extra = {}) {
            if (!post || !thread || !space || space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner || post.is_opening) return;
            await recordLocal('post', post.id, {
                title: `Re: ${thread.title}`, path: `/forum/${space.slug}/${thread.slug}#post-${post.id}`,
                actor: post.author_subject, origin: post.origin === 'ai' ? 'ai' : 'user', at: post.created_at,
                text: post.body_markdown, pictureUrl: extra.picture,
            });
        },
        async submissionAccepted(s) {
            if (!s || s.status !== 'accepted') return;
            await recordLocal('submission', s.slug, { title: s.title, path: `/submissions/${encodeURIComponent(s.slug)}`, actor: s.author_subject, origin: 'user', at: s.reviewed_at });
        },
        async submissionGone(slug) { await forgetLocal('submission', slug); },
        async threadGone(id) { await forgetLocal('thread', id); await forgetLocal('status', id); },
        async postGone(id) { await forgetLocal('post', id); },

        /** POST /api/v1/pulse/items (a service with community.pulse.write). → { item, created } */
        async ingest(v, body = {}) {
            const ref = body.ref;
            if (!ref || typeof ref !== 'object' || !contracts.validate('common.entity-ref@1', ref).valid) fail(400, 'ref.invalid', 'ref must be an EntityRef {service, type, id}');
            const own = serviceNameOf(v.service);
            if (ref.service !== own) fail(403, 'pulse.foreign_ref', `A service publishes Pulse items about its own entities (${own}), not ${ref.service}'s`);
            if (body.visibility != null && body.visibility !== 'public') fail(400, 'pulse.not_public', 'Only public activity enters Pulse');
            const title = String(body.title == null ? '' : body.title).replace(/\s+/g, ' ').trim();
            if (!title || title.length > 300) fail(400, 'pulse.invalid_title', 'title is required (at most 300 characters)');
            const url = String(body.url || '');
            let parsed = null;
            try { parsed = new URL(url); } catch { /* invalid */ }
            if (!parsed || !/^https?:$/.test(parsed.protocol) || url.length > 2000) fail(400, 'pulse.invalid_url', 'url must be an absolute http(s) URL');
            let origin = body.origin == null ? v.origin : body.origin;
            if (!ORIGINS.includes(origin)) fail(400, 'pulse.invalid_origin', `origin must be one of ${ORIGINS.join(', ')}`);
            if (v.origin === 'ai') origin = 'ai'; // X-OV-Origin: ai wins over a body that says otherwise
            const when = body.occurred_at == null ? new Date() : new Date(body.occurred_at);
            if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + FUTURE_SKEW_MS || when.getUTCFullYear() < 2000) fail(400, 'pulse.invalid_time', 'occurred_at must be an ISO time, not in the future');
            const media = body.media && typeof body.media === 'object' && !Array.isArray(body.media) ? body.media : {};
            const mediaUrl = (v) => { try { const x = new URL(String(v)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
            const thumb = mediaUrl(media.thumb);
            const preview = media.preview == null ? null : mediaUrl(media.preview);
            const ratio = media.ratio == null ? null : Number(media.ratio);
            const length = media.length == null ? null : Number(media.length);
            if (media.thumb != null && !thumb) fail(400, 'pulse.invalid_media', 'media.thumb must be an HTTPS Media URL');
            if (media.preview != null && !preview) fail(400, 'pulse.invalid_media', 'media.preview must be an HTTPS URL');
            if (ratio != null && (!Number.isFinite(ratio) || ratio <= 0 || ratio > 20)) fail(400, 'pulse.invalid_media', 'media.ratio must be between 0 and 20');
            if (length != null && (!Number.isFinite(length) || length < 0 || length > 86400)) fail(400, 'pulse.invalid_media', 'media.length must be between 0 and 86400 seconds');
            const out = await store.upsertItem(db, {
                source_service: ref.service, source_type: ref.type, source_id: ref.id,
                title, url: parsed.toString(),
                actor_subject: origin === 'user' ? (v.subject || null) : null,
                origin, occurred_at: sqlTime(when), picture_url: thumb, preview_url: preview, media_ratio: ratio, media_length: length,
            });
            const projections = await authors.projectionsFor([out.item.actor_subject]);
            return { item: shape(out.item, projections), created: out.created };
        },

        async contribute(v, body = {}) {
            if (!v.subject || v.claims.on_behalf_of !== v.subject || !String(v.service).startsWith('app:')) {
                fail(403, 'pulse.not_delegated', 'An app needs a grant from the person named in its token');
            }
            if (Object.keys(body).some((k) => !['id', 'text', 'url', 'picture_url'].includes(k))) fail(400, 'pulse.invalid', 'Only id, text, url and picture_url are accepted');
            const id = String(body.id || '');
            const title = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
            if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !title || title.length > 300) fail(400, 'pulse.invalid', 'id and text are required');
            let url;
            try { url = new URL(body.url); } catch { fail(400, 'pulse.invalid_url', 'An https URL is required'); }
            if (url.protocol !== 'https:' || url.toString().length > 2000) fail(400, 'pulse.invalid_url', 'An https URL is required');
            let picture = null;
            if (body.picture_url != null) {
                try { picture = new URL(body.picture_url); } catch { fail(400, 'pulse.picture_proxy_required', 'A Media picture URL is required'); }
                if (picture.protocol !== 'https:' || picture.hostname !== 'openvibe.media' || !/^\/(?:t|o)\//.test(picture.pathname) || picture.toString().length > 2000) {
                    fail(400, 'pulse.picture_proxy_required', 'Pictures must use Media HTTPS thumbnail or object URLs');
                }
            }
            const at = Date.now();
            const times = (appWrites.get(v.service) || []).filter((t) => at - t < 60_000);
            if (times.length >= 10) fail(429, 'pulse.app_rate_limited', 'At most ten contributions per app per minute');
            times.push(at); appWrites.set(v.service, times);
            if (appWrites.size > 5000) appWrites.delete(appWrites.keys().next().value);
            const out = await store.upsertItem(db, { source_service: v.service, source_type: 'contribution', source_id: `${v.subject}:${id}`,
                title, url: url.toString(), picture_url: picture && picture.toString(), app_name: String(v.claims.app_name || '').slice(0, 80) || null,
                actor_subject: v.subject, origin: 'user', occurred_at: sqlTime(at) });
            const projections = await authors.projectionsFor([v.subject]);
            return { item: shape(out.item, projections), created: out.created };
        },

        async retractContribution(v, service, type, id) {
            if (service !== v.service || type !== 'contribution' || !v.subject || v.claims.on_behalf_of !== v.subject || !id.startsWith(`${v.subject}:`)) {
                fail(403, 'pulse.foreign_ref', 'An app retracts only its own items for the consenting person');
            }
            return { removed: await store.removeItem(db, service, type, id) };
        },

        /** DELETE /api/v1/pulse/items/:service/:type/:id — a service retracting its own item. */
        async retract(v, service, type, id) {
            if (service !== serviceNameOf(v.service)) fail(403, 'pulse.foreign_ref', 'A service retracts only its own items');
            return { removed: await store.removeItem(db, service, type, id) };
        },

        /** The origins that have at least one listable item (the page offers a filter only for those), cached a minute. */
        async origins() {
            if (originsCache.list && Date.now() - originsCache.at < 60_000) return originsCache.list;
            const list = [];
            for (const origin of ORIGINS) {
                if ((await store.listItems(db, { origin, limit: 1 })).rows.length) list.push(origin);
            }
            originsCache = { at: Date.now(), list };
            return list;
        },

        /** GET /api/v1/pulse ?origin=user|ai|system&after=<cursor>&limit= → { items, next_cursor } */
        async list(q = {}, viewer = null) {
            const origin = q.origin == null || q.origin === '' || q.origin === 'all' ? null : String(q.origin);
            if (origin && !ORIGINS.includes(origin)) fail(400, 'pulse.invalid_origin', `origin must be one of ${ORIGINS.join(', ')}`);
            const mine = q.for === 'me';
            if (q.for && !mine) fail(400, 'pulse.invalid_for', 'for must be me');
            if (mine && (!viewer || viewer.kind !== 'user' || !viewer.token)) fail(401, 'pulse.sign_in_required', 'Sign in for your feed');
            const limit = Math.min(Math.max(parseInt(q.limit, 10) || (mine ? 20 : PAGE), 1), 100);
            const before = mine ? decodeCursor(q.cursor || q.after, 4) : decodeCursor(q.after, 2);
            if (mine && before && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(before[0])
                || ![0, 1].includes(before[1]) || typeof before[2] !== 'string' || !Number.isSafeInteger(before[3]))) {
                fail(400, 'request.invalid_cursor', 'That cursor is not one this API issued');
            }
            const followed = mine ? await followedSubjects(viewer) : [];
            const hour = mine ? (before ? before[0] : sqlTime(Date.now() - 60 * 60_000)) : null;
            const { rows, hasMore } = await store.listItems(db, { origin, before: before && (mine ? before.slice(1) : [0, ...before]), limit, followed, hour });
            const projections = await authors.projectionsFor(rows.map((r) => r.actor_subject));
            const last = rows[rows.length - 1];
            return { items: rows.map((r) => shape(r, projections)), next_cursor: hasMore && last
                ? encodeCursor(mine ? [hour, last.feed_priority, last.occurred_at, last.id] : [last.occurred_at, last.id]) : null,
                // What this reader may do here: the menu's Feed shows its composer only when this says so (openvibe-shared
                // ov-home.js), so it never offers a post the status route would refuse.
                ...(viewer && viewer.kind === 'user' && viewer.subject ? { viewer: { can_post: true } } : {}) };
        },
    };
}

module.exports = { createPulse, serviceNameOf, ORIGINS };
