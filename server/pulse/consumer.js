'use strict';
/**
 * OpenVibe.Events → Pulse: POST /internal/events, the endpoint of Community's Events subscriptions
 * (consumer `community`, created at boot by startSubscriptions()). Public activity from other services
 * becomes Pulse items (roadmap §29 / §33: provenance kept, AI never shown as a person):
 *
 *   live.stream.started     "<channel> went live: <title>"  → the channel page, actor the streamer
 *   blog.post.published     "New post on the <blog> blog"   → the post (public, indexable only)
 *   wiki.page.published     "Wiki: <space> / <slug>"        → the page (public, indexable only)
 *   news.story.published    "News: <topic>"                 → the story (public, indexable only)
 *
 * And revocation (WS-B task 4): network.user.token_valid_after (source network) moves the person's token
 * cutoff (openvibe-sdk createRevocationStore); the viewer resolver refuses their older tokens.
 *
 * And VIP convergence: vip.membership.changed (source vip) drops the member's cached members-only
 * answers for that creator at once (the VIP gate's cache handleEvent) instead of waiting out its TTL.
 *
 * And platform blocks (WS-E task 5): network.block.changed (source network) updates the network_blocks
 * projection (../identity/blocks.js; the newest revision per pair wins) that replies and comments honour.
 *
 * Exactly once: the openvibe-sdk inbox claims (consumer, event_id) in the same transaction as the Pulse
 * write. Signature v2 only (parseDelivery requireV2) under COMMUNITY_EVENTS_SECRET (comma-separated for
 * rotation, 32+ characters each); unset = 503. Loopback only: a request carrying a forwarding header
 * came through nginx and is refused.
 */
const express = require('express');
const { http, serviceAuth } = require('openvibe-contracts');
const { parseDelivery, createInbox } = require('openvibe-sdk/events');
const store = require('./store');
const blocks = require('../identity/blocks');

const CONSUMER = 'community';
const TOPICS = Object.freeze(['live.stream.started', 'blog.post.published', 'wiki.page.published', 'news.story.published', 'vip.membership.changed', 'network.user.token_valid_after', 'network.block.changed']);
const EVENT_ID_RE = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(u) ? u.slice(0, 500) : null);
const subjectOf = (ref) => (ref && ref.type === 'user' && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref.id) ? ref.id : null);
const publicIndexable = (p) => p && p.visibility === 'public' && (!p.indexability || p.indexability.decision !== 'noindex');

/** An envelope → a Pulse item, or an 'ignored:*' reason. */
function itemFor(event) {
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const at = event.occurred_at || event.timestamp || new Date().toISOString();
    const subjectId = String((event.subject && event.subject.id) || '');
    if (event.event_type === 'live.stream.started') {
        if (event.visibility !== 'public' || event.source !== 'live') return 'ignored:not_public';
        const ch = p.channel || {};
        const url = httpsUrl(ch.url);
        if (!url || !subjectId) return 'ignored:payload';
        const name = clean(ch.display_name || ch.username, 60);
        const title = clean(p.title, 120);
        return { source_service: 'live', source_type: 'stream', source_id: subjectId, title: title ? `${name} went live: ${title}` : `${name} went live`, url, actor_subject: subjectOf(ch.subject), origin: 'user', occurred_at: p.started_at || at };
    }
    const kinds = { 'blog.post.published': ['blog', 'post'], 'wiki.page.published': ['wiki', 'page'], 'news.story.published': ['news', 'story'] };
    const k = kinds[event.event_type];
    if (!k) return 'ignored:type';
    if (event.source !== k[0]) return 'ignored:source';
    if (!publicIndexable(p)) return 'ignored:not_public';
    const url = httpsUrl(p.canonical_url);
    if (!url || !subjectId) return 'ignored:payload';
    const title = k[0] === 'blog' ? `New post on the ${clean(p.blog, 60) || 'OpenVibe'} blog`
        : k[0] === 'wiki' ? `Wiki: ${clean(p.space, 40)} / ${clean(p.slug, 60)}`
            : `News: ${clean(p.topic, 60) || 'a new story'}`;
    const actor = event.actor && event.actor.type === 'user' ? subjectOf(event.actor) : null;
    return { source_service: k[0], source_type: k[1], source_id: subjectId, title, url, actor_subject: actor, origin: actor ? 'user' : 'system', occurred_at: at };
}

function createPulseConsumer({ db, secrets = [], vipCache = null, revocations = null, now = () => Date.now(), log = console } = {}) {
    const keys = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 32);
    const inbox = createInbox(db, { table: 'community_event_inbox', now });
    inbox.ensureSchema();
    const stats = { received: 0, applied: 0, duplicates: 0, ignored: 0, refused: 0, failed: 0, last_at: null };
    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        const ctx = http.requestContext(req.headers);
        const problem = (status, code, detail) => http.sendProblem(res, status, code, { detail, ctx });
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return problem(403, 'community.internal_only', 'internal route');
        if (!keys.length) return problem(503, 'community.events_disabled', 'COMMUNITY_EVENTS_SECRET is not set');
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let delivery = null;
        for (const s of keys) { delivery = parseDelivery(raw, req.headers, s, { requireV2: true, now: now() }); if (delivery) break; }
        if (!delivery) { stats.refused++; return problem(401, 'community.bad_signature', 'X-OpenVibe-Signature-V2 does not verify or is outside the replay window'); }
        const event = delivery.event;
        if (!event || !EVENT_ID_RE.test(String(event.event_id || '')) || typeof event.event_type !== 'string') { stats.refused++; return problem(400, 'community.bad_delivery', 'body must be { event: <envelope>, seq }'); }
        stats.received++; stats.last_at = new Date(now()).toISOString();
        if (event.event_type === 'network.user.token_valid_after') {
            if (!revocations) { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: 'ignored:no_store' }); }
            const r = inbox.once(CONSUMER, event.event_id, () => ({ outcome: revocations.apply(event) }));
            if (r.duplicate) stats.duplicates++; else stats.applied++;
            return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
        }
        if (event.event_type === 'network.block.changed') {
            const p = blocks.payloadOf(event);
            if (typeof p === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: p }); }
            try {
                const r = inbox.once(CONSUMER, event.event_id, () => ({ outcome: blocks.apply(db, p, now()) }));
                if (r.duplicate) stats.duplicates++; else stats.applied++;
                return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
            } catch (err) {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                return problem(500, 'community.event_failed', 'processing failed; it will be retried');
            }
        }
        if (event.event_type === 'vip.membership.changed') {
            if (event.source !== 'vip' || !vipCache) { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: event.source !== 'vip' ? 'ignored:source' : 'ignored:no_gate' }); }
            const r = inbox.once(CONSUMER, event.event_id, () => ({ outcome: vipCache.handleEvent(event) ? 'vip:invalidated' : 'vip:unchanged' }));
            if (r.duplicate) stats.duplicates++; else stats.applied++;
            return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
        }
        const item = itemFor(event);
        if (typeof item === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: item }); }
        try {
            const r = inbox.once(CONSUMER, event.event_id, () => ({ outcome: store.upsertItem(db, item).created ? 'pulse:created' : 'pulse:updated' }));
            if (r.duplicate) stats.duplicates++; else stats.applied++;
            return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
        } catch (err) {
            stats.failed++;
            log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
            return problem(500, 'community.event_failed', 'processing failed; it will be retried');
        }
    });
    return { router, stats: () => ({ ...stats, enabled: keys.length > 0 }) };
}

/** Create any missing subscription for TOPICS at Events (idempotent; retried in the background at boot). */
function startSubscriptions({ config, port, secret, eventsUrl = process.env.EVENTS_URL, fetchImpl = globalThis.fetch, log = console }) {
    if (!eventsUrl || !secret || !config.oauth.clientSecret || process.env.COMMUNITY_EVENTS_SUBSCRIBE === '0') return null;
    const base = String(eventsUrl).replace(/\/+$/, '');
    const endpoint = process.env.COMMUNITY_EVENTS_ENDPOINT || `http://127.0.0.1:${port}/internal/events`;
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.events', scope: 'events.subscription.manage', fetchImpl });
    const call = async (method, path, body) => {
        const res = await fetchImpl(`${base}${path}`, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, body: json };
    };
    const attempt = async () => {
        const listed = await call('GET', '/api/v1/subscriptions');
        if (!listed.ok) throw new Error(`listing subscriptions: ${listed.status}`);
        const mine = (listed.body.subscriptions || []).filter((s) => s.endpoint === endpoint);
        for (const topic of TOPICS) {
            if (mine.some((s) => s.topic_pattern === topic)) continue;
            const r = await call('POST', '/api/v1/subscriptions', { topic_pattern: topic, endpoint, secret });
            if (!r.ok && r.status !== 409) throw new Error(`subscribing to ${topic}: ${r.status} ${r.body.code || ''}`);
            if (r.ok) log.log(`[Pulse consumer] subscription created: ${r.body.id} (${topic} → ${endpoint})`);
        }
    };
    const delays = [0, 10_000, 60_000, 5 * 60_000, 15 * 60_000];
    let i = 0;
    const run = () => attempt().catch((err) => {
        if (++i < delays.length) { const t = setTimeout(run, delays[i]); if (t.unref) t.unref(); } else log.warn('[Pulse consumer] subscriptions not created:', err.message);
    });
    const t = setTimeout(run, delays[0]); if (t.unref) t.unref();
    return { topics: TOPICS, endpoint };
}

module.exports = { createPulseConsumer, startSubscriptions, itemFor, TOPICS };
