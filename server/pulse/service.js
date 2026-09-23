'use strict';

/**
 * Pulse — a read model of public activity across the network, with provenance.
 *
 * Sources:
 *   - Community's own public activity, recorded at write time (the hooks below): new public
 *     pastes written by a person (not burn-after-read, not NSFW), new threads and replies in
 *     public spaces. Deletes and visibility changes take items out again, and listItems()
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

function createPulse({ db, network = null, config = {} } = {}) {
    const authors = createAuthors({ db, network });
    const base = (config.baseUrl || '').replace(/\/$/, '');

    /** Record one of Community's own items; never lets a Pulse problem fail the write that caused it. */
    function recordLocal(type, id, { title, path, actor = null, origin = 'user', at = null }) {
        try {
            const o = ORIGINS.includes(origin) ? origin : 'user';
            store.upsertItem(db, {
                source_service: 'community', source_type: type, source_id: String(id),
                title: String(title || 'Untitled').slice(0, 300), url: `${base}${path}`,
                actor_subject: o === 'user' ? actor : null, origin: o, occurred_at: at || sqlTime(),
            });
        } catch (err) { console.warn('[Pulse] record failed:', err.message); }
    }
    function forgetLocal(type, id) {
        try { store.removeItem(db, 'community', type, id); } catch (err) { console.warn('[Pulse] remove failed:', err.message); }
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
            actor,
            occurred_at: isoTime(i.occurred_at),
        };
    }

    return {
        ORIGINS,

        // ── hooks for Community's own writes ─────────────────
        pasteCreated(p) {
            if (!p || p.visibility !== 'public' || p.origin !== 'user' || Number(p.burn_after_read) || Number(p.is_nsfw)) return;
            recordLocal('paste', p.slug, { title: p.title, path: `/p/${encodeURIComponent(p.slug)}`, actor: p.owner_subject, origin: 'user', at: p.created_at });
        },
        pasteChanged(p) {
            if (!p) return;
            if (p.deleted_at || p.visibility !== 'public' || Number(p.is_nsfw)) forgetLocal('paste', p.slug);
        },
        pasteGone(slug) { forgetLocal('paste', slug); },
        threadCreated(thread, space) {
            if (!thread || !space || space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner) return;
            recordLocal('thread', thread.id, {
                title: thread.title, path: `/s/${space.slug}/t/${thread.slug}`,
                actor: thread.author_subject, origin: thread.origin === 'ai' ? 'ai' : (thread.origin === 'system' ? 'system' : 'user'), at: thread.created_at,
            });
        },
        postCreated(post, thread, space) {
            if (!post || !thread || !space || space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner || post.is_opening) return;
            recordLocal('post', post.id, {
                title: `Re: ${thread.title}`, path: `/s/${space.slug}/t/${thread.slug}#post-${post.id}`,
                actor: post.author_subject, origin: post.origin === 'ai' ? 'ai' : 'user', at: post.created_at,
            });
        },
        threadGone(id) { forgetLocal('thread', id); },
        postGone(id) { forgetLocal('post', id); },

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
            const out = store.upsertItem(db, {
                source_service: ref.service, source_type: ref.type, source_id: ref.id,
                title, url: parsed.toString(),
                actor_subject: origin === 'user' ? (v.subject || null) : null,
                origin, occurred_at: sqlTime(when),
            });
            const projections = await authors.projectionsFor([out.item.actor_subject]);
            return { item: shape(out.item, projections), created: out.created };
        },

        /** DELETE /api/v1/pulse/items/:service/:type/:id — a service retracting its own item. */
        retract(v, service, type, id) {
            if (service !== serviceNameOf(v.service)) fail(403, 'pulse.foreign_ref', 'A service retracts only its own items');
            return { removed: store.removeItem(db, service, type, id) };
        },

        /** GET /api/v1/pulse ?origin=user|ai|system&after=<cursor>&limit= → { items, next_cursor } */
        async list(q = {}) {
            const origin = q.origin == null || q.origin === '' || q.origin === 'all' ? null : String(q.origin);
            if (origin && !ORIGINS.includes(origin)) fail(400, 'pulse.invalid_origin', `origin must be one of ${ORIGINS.join(', ')}`);
            const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE, 1), 100);
            const before = decodeCursor(q.after, 2);
            const { rows, hasMore } = store.listItems(db, { origin, before, limit });
            const projections = await authors.projectionsFor(rows.map((r) => r.actor_subject));
            const last = rows[rows.length - 1];
            return { items: rows.map((r) => shape(r, projections)), next_cursor: hasMore && last ? encodeCursor([last.occurred_at, last.id]) : null };
        },
    };
}

module.exports = { createPulse, serviceNameOf, ORIGINS };
