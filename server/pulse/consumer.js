'use strict';
/**
 * OpenVibe.Events → Pulse: POST /internal/events, the endpoint of Community's Events subscriptions
 * (consumer `community`, created at boot by startSubscriptions()). Public activity from other services
 * becomes Pulse items (roadmap §29 / §33: provenance kept, AI never shown as a person):
 *
 *   live.stream.started     "<channel> went live: <title>"  → the channel page, actor the streamer
 *   mediahub.video.published the public video upload
 *   games.world.published   the creator's public world
 *   blog.post.published     "New post on the <blog> blog"   → the post (public, indexable only)
 *   wiki.page.published     "Wiki: <space> / <slug>"        → the page (public, indexable only)
 *   news.story.published    "News: <topic>"                 → the story (public, indexable only)
 *
 * And game progress (roadmap WS-M task 2, PF7): network.module.updated (source network) for a person's
 * games.progress.summary record, whose `level` Contracts declares public. game_progress keeps the last level
 * seen per person; a later record that crosses a multiple of GAME_MILESTONE becomes one Pulse item,
 * "Reached level <n> in Scraplandia" (Games · level), with the person as its actor. The first record
 * seen for a person is only a baseline (no stale "reached" item for a level reached long ago); levels
 * that go down or stay put announce nothing; only the public fields are read.
 *
 * And revocation (WS-B task 4): network.user.token_valid_after (source network) moves the person's token
 * cutoff (openvibe-sdk createPgRevocationStore); the viewer resolver refuses their older tokens.
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
const { parseDelivery, createPgInbox } = require('openvibe-sdk/events');
const store = require('./store');
const blocks = require('../identity/blocks');

const CONSUMER = 'community';
const TOPICS = Object.freeze(['live.stream.started', 'mediahub.video.published', 'games.world.published', 'blog.post.published', 'wiki.page.published', 'wiki.page.updated', 'chat.room.message.created', 'news.story.published', 'vip.membership.changed', 'network.user.token_valid_after', 'network.user.updated', 'network.block.changed', 'network.module.updated', 'network.account.export_requested', 'network.account.deleted']);
const GAME_NAMESPACE = 'games.progress.summary';
const GAME_MILESTONE = 5;
const GAME_URL = 'https://openvibe.games/';
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
    const kinds = { 'mediahub.video.published': ['media-hub', 'video'], 'games.world.published': ['games', 'world'], 'blog.post.published': ['blog', 'post'], 'wiki.page.published': ['wiki', 'page'], 'wiki.page.updated': ['wiki', 'page'], 'news.story.published': ['news', 'story'] };
    const k = kinds[event.event_type];
    if (!k) return 'ignored:type';
    if (event.source !== k[0]) return 'ignored:source';
    if (event.event_type === 'mediahub.video.published' || event.event_type === 'games.world.published') {
        if (event.visibility !== 'public') return 'ignored:not_public';
    } else if (!publicIndexable(p)) return 'ignored:not_public';
    const url = httpsUrl(p.canonical_url || p.url);
    if (!url || !subjectId) return 'ignored:payload';
    // blog.post.published names its blog as { id, handle } (contracts payload v1); a plain string is still read.
    const blogName = clean(p.blog && typeof p.blog === 'object' ? p.blog.handle : p.blog, 60);
    const title = k[0] === 'media-hub' || k[0] === 'games' ? clean(p.title, 160)
        : k[0] === 'blog' ? (blogName ? `New post on the ${blogName} blog` : 'New post on an OpenVibe blog')
        // A wiki page by its title when the event carries one (contracts 0.366.0), else by where it lives.
        : k[0] === 'wiki' ? (clean(p.title, 160) || `Wiki: ${clean(p.space, 40)} / ${clean(p.slug, 60)}`)
            : `News: ${clean(p.topic, 60) || 'a new story'}`;
    const actor = event.actor && event.actor.type === 'user' ? subjectOf(event.actor) : null;
    // An edited page moves to the top: the feed says "new and updated Wiki articles", not only first publications.
    return { source_service: k[0], source_type: k[1], source_id: subjectId, title, url, actor_subject: actor, origin: actor ? 'user' : 'system', occurred_at: at,
        ...(event.event_type === 'wiki.page.updated' ? { touch: true } : {}) };
}

/** A public chat room message → { slug, name, at } or an 'ignored:*' reason. */
function chatMessageOf(event) {
    if (event.source !== 'chat') return 'ignored:source';
    if (event.visibility !== 'public') return 'ignored:not_public';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const slug = clean(p.room && p.room.slug, 64);
    if (!slug) return 'ignored:payload';
    const at = Date.parse(String(p.created_at || event.occurred_at || event.timestamp || ''));
    if (!Number.isFinite(at)) return 'ignored:payload';
    return { slug, name: clean(p.room && p.room.name, 80), at };
}

/** network.module.updated → { subject, level, at } for a games.progress.summary write, or an 'ignored:*' reason. */
function gameProgressOf(event) {
    if (event.source !== 'network') return 'ignored:source';
    const p = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (p.namespace !== GAME_NAMESPACE) return 'ignored:namespace';
    if (p.change !== 'created' && p.change !== 'updated') return 'ignored:change';
    const subject = subjectOf(p.owner);
    const level = p.public && Number.isInteger(p.public.level) ? p.public.level : null;
    if (!subject || level == null || level < 0 || level > 100000) return 'ignored:payload';
    return { subject, level, at: event.occurred_at || event.timestamp || new Date().toISOString() };
}

/** Network's profile event carries a changed list; only an avatar edit can make an avatar card. */
async function applyAvatar(db, event) {
    if (event.source !== 'network') return 'ignored:source';
    const p = event.payload || {};
    const who = subjectOf(p.subject);
    const revision = Number(p.revision);
    if (!who || !Number.isSafeInteger(revision) || revision < 1) return 'ignored:payload';
    const old = await db.prepare('SELECT revision FROM pulse_profile_revision WHERE subject = ?').get(who);
    if (old && Number(old.revision) >= revision) return 'ignored:old_revision';
    await db.prepare(`INSERT INTO pulse_profile_revision (subject, revision) VALUES (?, ?)
        ON CONFLICT(subject) DO UPDATE SET revision = excluded.revision`).run(who, revision);
    if (p.banned) { await store.removeItem(db, 'network', 'avatar', who); return 'avatar:removed'; }
    if (!Array.isArray(p.changed) || !p.changed.includes('avatar_url')) return 'profile:updated';
    await store.removeItem(db, 'network', 'avatar', who);
    if (p.banned || !p.avatar_url) return 'avatar:removed';
    const avatar = httpsUrl(p.avatar_url);
    const username = clean(p.username, 64);
    if (!avatar || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) return 'ignored:payload';
    await store.upsertItem(db, { source_service: 'network', source_type: 'avatar', source_id: who,
        title: `${clean(p.display_name || username, 80)} uploaded a new avatar`,
        url: `https://openvibe.network/@${encodeURIComponent(username)}`, picture_url: avatar,
        actor_subject: who, origin: 'user', occurred_at: event.occurred_at || event.timestamp || new Date().toISOString() });
    return 'pulse:created';
}

/** Record the level; a crossed milestone becomes a Pulse item. Inside the inbox claim. → outcome */
async function applyGameProgress(db, g) {
    const prev = await db.prepare('SELECT level FROM game_progress WHERE subject_id = ?').get(g.subject);
    await db.prepare(`INSERT INTO game_progress (subject_id, level, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(subject_id) DO UPDATE SET level = GREATEST(game_progress.level, excluded.level), updated_at = excluded.updated_at`).run(g.subject, g.level, g.at);
    if (!prev) return 'games:baseline';
    const milestone = Math.floor(g.level / GAME_MILESTONE) * GAME_MILESTONE;
    if (milestone <= prev.level || milestone < GAME_MILESTONE) return 'games:no_milestone';
    const r = await store.upsertItem(db, { source_service: 'games', source_type: 'level', source_id: `${g.subject}:${milestone}`, title: `Reached level ${milestone} in Scraplandia`,
        url: GAME_URL, actor_subject: g.subject, origin: 'user', occurred_at: g.at });
    return r.created ? 'pulse:created' : 'pulse:updated';
}

function createPulseConsumer({ db, secrets = [], vipCache = null, revocations = null, accountSend = null, now = () => Date.now(), log = console } = {}) {
    const keys = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 32);
    // Receipts (community_event_inbox) are in migrations/0001_initial.sql.
    const inbox = createPgInbox(db, { table: 'community_event_inbox', now });
    const stats = { received: 0, applied: 0, duplicates: 0, ignored: 0, refused: 0, failed: 0, last_at: null };
    // A public room's messages are counted per UTC hour; at five the hour becomes one Chat card, refreshed every
    // five messages after that. This is in memory on purpose: a restart only starts counting the current hour again.
    const chatHours = new Map();
    const CHAT_BUSY_MESSAGES = 5;
    async function applyChatMessage(c) {
        const hour = new Date(c.at).toISOString().slice(0, 13);
        const key = `${c.slug}:${hour}`;
        const n = (chatHours.get(key) || 0) + 1;
        chatHours.set(key, n);
        if (chatHours.size > 5000) chatHours.delete(chatHours.keys().next().value);
        if (n < CHAT_BUSY_MESSAGES || (n !== CHAT_BUSY_MESSAGES && n % 5 !== 0)) return 'chat:counted';
        const out = await store.upsertItem(db, {
            source_service: 'chat', source_type: 'hour', source_id: key,
            title: `#${c.slug}: ${n} messages this hour`,
            url: `https://openvibe.chat/rooms/${encodeURIComponent(c.slug)}`,
            actor_subject: null, origin: 'system', occurred_at: `${hour}:00:00Z`, text: '',
        });
        return out.created ? 'pulse:created' : 'pulse:updated';
    }
    const router = express.Router();
    router.post('/', express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
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
            const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: await revocations.apply(event) }));
            if (r.duplicate) stats.duplicates++; else stats.applied++;
            return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
        }
        if (event.event_type === 'network.block.changed') {
            const p = blocks.payloadOf(event);
            if (typeof p === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: p }); }
            try {
                const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: await blocks.apply(db, p, now()) }));
                if (r.duplicate) stats.duplicates++; else stats.applied++;
                return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
            } catch (err) {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                return problem(500, 'community.event_failed', 'processing failed; it will be retried');
            }
        }
        if (event.event_type === 'network.account.export_requested' || event.event_type === 'network.account.deleted') {
            // Account export and deletion (ADR-033, ../identity/account-data.js): once per export or deletion by its own record,
            // answered after Network took the part or confirmation, so a failure is redelivered without erasing twice.
            if (!accountSend) { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: 'ignored:no_client' }); }
            return require('../identity/account-data').apply(db, event, { send: accountSend, log }).then((outcome) => {
                stats.applied++;
                res.json({ event_id: event.event_id, duplicate: outcome === 'unchanged', outcome });
            }, (err) => {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                problem(500, 'community.event_failed', 'processing failed; it will be retried');
            });
        }
                if (event.event_type === 'vip.membership.changed') {
            if (event.source !== 'vip' || !vipCache) { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: event.source !== 'vip' ? 'ignored:source' : 'ignored:no_gate' }); }
            const r = await inbox.once(CONSUMER, event.event_id, () => ({ outcome: vipCache.handleEvent(event) ? 'vip:invalidated' : 'vip:unchanged' }));
            if (r.duplicate) stats.duplicates++; else stats.applied++;
            return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
        }
        if (event.event_type === 'network.module.updated') {
            const g = gameProgressOf(event);
            if (typeof g === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: g }); }
            try {
                const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: await applyGameProgress(db, g) }));
                if (r.duplicate) stats.duplicates++; else stats.applied++;
                return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
            } catch (err) {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                return problem(500, 'community.event_failed', 'processing failed; it will be retried');
            }
        }
        if (event.event_type === 'network.user.updated') {
            try {
                const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: await applyAvatar(db, event) }));
                if (r.duplicate) stats.duplicates++; else stats.applied++;
                return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
            } catch (err) {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                return problem(500, 'community.event_failed', 'processing failed; it will be retried');
            }
        }
        if (event.event_type === 'chat.room.message.created') {
            const c = chatMessageOf(event);
            if (typeof c === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: c }); }
            try {
                const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: await applyChatMessage(c) }));
                if (r.duplicate) stats.duplicates++; else stats.applied++;
                return res.json({ event_id: event.event_id, duplicate: r.duplicate, outcome: r.duplicate ? null : r.result.outcome });
            } catch (err) {
                stats.failed++;
                log.error(`[Pulse consumer] ${event.event_id} (${event.event_type}) failed:`, err.message);
                return problem(500, 'community.event_failed', 'processing failed; it will be retried');
            }
        }
        const item = itemFor(event);
        if (typeof item === 'string') { stats.ignored++; return res.json({ event_id: event.event_id, duplicate: false, outcome: item }); }
        try {
            // A reconnect is a new Live session and a new event; the stream itself is one broadcast.
            const put = item.source_service === 'live' && item.source_type === 'stream' ? store.upsertLiveItem : store.upsertItem;
            const r = await inbox.once(CONSUMER, event.event_id, async () => ({ outcome: (await put(db, item)).created ? 'pulse:created' : 'pulse:updated' }));
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
    let timer = null;
    let stopped = false;
    const run = () => { timer = null; if (stopped) return; attempt().catch((err) => {
        if (stopped) return;
        if (++i < delays.length) { timer = setTimeout(run, delays[i]); if (timer.unref) timer.unref(); } else log.warn('[Pulse consumer] subscriptions not created:', err.message);
    }); };
    timer = setTimeout(run, delays[0]); if (timer.unref) timer.unref();
    // Graceful stop: no further attempts (they run again at the next start).
    return { topics: TOPICS, endpoint, stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { createPulseConsumer, startSubscriptions, itemFor, chatMessageOf, gameProgressOf, TOPICS, GAME_MILESTONE };
