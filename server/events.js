'use strict';
/**
 * Community → OpenVibe.Events (contracts community.*@1, openvibe-contracts 0.35.0).
 *
 *   community.paste.created | updated | deleted     server/pastes/store.js
 *   community.thread.created, community.post.created server/forum/store.js
 *   community.comment.created                        server/comments/store.js
 *
 * Each event is written to Community's own outbox inside the SAME transaction as the change (the SDK
 * outbox refuses anything else), and a relay publishes it with Community's service token (audience
 * openvibe.events, capability events.event.publish). Events down: rows wait and are retried; a write
 * never waits on Events. Payloads carry ids, the owner/author subject, visibility and the public URL,
 * never a body, title or content. Envelope visibility is public only for public items.
 *
 * Off unless EVENTS_URL and OV_OAUTH_CLIENT_SECRET are set (EVENTS_PUBLISH=off disables it).
 */
const { createClient } = require('openvibe-sdk/core');
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const { createEventsClient, createOutbox } = require('openvibe-sdk/events');
const config = require('./config');

let outbox = null;
let pruneTimer = null;
const stats = { queued: 0, lastError: null };
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

function init(db, { eventsUrl = process.env.EVENTS_URL, clientSecret = config.oauth && config.oauth.clientSecret, fetchImpl, intervalMs } = {}) {
    if (outbox) return outbox;
    if (process.env.EVENTS_PUBLISH === 'off' || !eventsUrl || !clientSecret) return null;
    const tokens = createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: (config.oauth && config.oauth.clientId) || 'community', clientSecret, fetch: fetchImpl });
    const client = createClient({ baseUrls: { events: String(eventsUrl).replace(/\/+$/, '') }, tokenProvider: tokens, fetch: fetchImpl, retries: 0 });
    outbox = createOutbox(db, {
        events: createEventsClient(client, { source: 'community' }),
        intervalMs: intervalMs || 2000,
        onError: (err) => { const m = err && err.message; if (m !== stats.lastError) console.warn('[Events] publish failed (will retry):', m); stats.lastError = m; },
    });
    outbox.ensureSchema();
    outbox.start();
    pruneTimer = setInterval(() => { try { outbox.prune(); } catch { /* next time */ } }, PRUNE_EVERY_MS);
    if (pruneTimer.unref) pruneTimer.unref();
    console.log(`[Events] community → ${eventsUrl} (${outbox.pending()} pending)`);
    return outbox;
}

const subjectRef = (sub) => (sub && /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(sub) ? { type: 'user', id: sub } : (sub && /^gst_/.test(sub) ? { type: 'guest', id: sub } : null));

/**
 * Queue one event. MUST run inside the transaction that makes the change; throws if the insert fails,
 * so the change rolls back with it. A no-op (null) while publishing is off.
 */
function record(eventType, subject, payload, { isPublic = false, actor = null } = {}) {
    if (!outbox) return null;
    const env = outbox.enqueue({
        event_type: eventType,
        actor: actor || { type: 'service', id: 'community' },
        subject,
        visibility: isPublic ? 'public' : 'internal',
        priority: 'low',
        payload,
    });
    stats.queued++;
    setImmediate(() => outbox && outbox.kick());
    return env;
}

// ── Builders (read the row as it is after the change) ─────────────────────────────
const pasteUrl = (p) => (p.visibility === 'public' && !p.deleted_at ? `${config.baseUrl}/p/${encodeURIComponent(p.slug)}` : null);
const actorOf = (sub) => { const r = subjectRef(sub); return r ? { type: r.type, id: r.id } : null; };

function pasteCreated(p) {
    return record('community.paste.created', { type: 'paste', id: p.slug }, {
        paste_id: p.slug, type: p.type === 'screenshot' ? 'screenshot' : 'paste', origin: ['user', 'ai', 'import'].includes(p.origin) ? p.origin : 'user',
        visibility: p.visibility || 'public', owner: subjectRef(p.owner_subject), url: pasteUrl(p),
    }, { isPublic: p.visibility === 'public', actor: actorOf(p.owner_subject) });
}
function pasteUpdated(p, changed) {
    const list = [...new Set(changed)].filter((c) => ['title', 'content', 'language', 'visibility', 'is_nsfw', 'pinned'].includes(c));
    if (!list.length) return null;
    return record('community.paste.updated', { type: 'paste', id: p.slug, revision: Number(p.revision) || 1 }, {
        paste_id: p.slug, changed: list, visibility: p.deleted_at ? 'deleted' : (p.visibility || 'public'), revision: Number(p.revision) || 1, url: pasteUrl(p),
    }, { isPublic: p.visibility === 'public' });
}
function pasteDeleted(slug) {
    return record('community.paste.deleted', { type: 'paste', id: slug }, { paste_id: slug }, { isPublic: true });
}
// A thread or post is public only in a public space and outside a members-only thread (staff spaces count as members).
const forumVisibility = (thread, spaceVisibility) => (thread.members_only_owner || spaceVisibility !== 'public' ? 'members' : 'public');
function threadCreated(thread, spaceSlug, spaceVisibility = 'public') {
    const visibility = forumVisibility(thread, spaceVisibility);
    return record('community.thread.created', { type: 'thread', id: String(thread.id) }, {
        thread_id: Number(thread.id), space: spaceSlug, author: subjectRef(thread.author_subject), visibility,
        url: visibility === 'public' ? `${config.baseUrl}/s/${encodeURIComponent(spaceSlug)}/t/${encodeURIComponent(thread.slug)}` : null,
    }, { isPublic: visibility === 'public', actor: actorOf(thread.author_subject) });
}
function postCreated(post, thread, spaceSlug, spaceVisibility = 'public') {
    const visibility = forumVisibility(thread, spaceVisibility);
    return record('community.post.created', { type: 'post', id: String(post.id) }, {
        post_id: Number(post.id), thread_id: Number(thread.id), space: spaceSlug, author: subjectRef(post.author_subject), visibility,
        url: visibility === 'public' ? `${config.baseUrl}/s/${encodeURIComponent(spaceSlug)}/t/${encodeURIComponent(thread.slug)}#p${post.id}` : null,
    }, { isPublic: visibility === 'public', actor: actorOf(post.author_subject) });
}
function commentCreated(comment, cthread) {
    const visibility = ['public', 'hidden', 'locked'].includes(cthread.visibility) ? cthread.visibility : 'public';
    return record('community.comment.created', { type: 'comment', id: String(comment.id) }, {
        comment_id: Number(comment.id), thread_access_id: String(cthread.access_id), ref: { service: cthread.ref_service, type: cthread.ref_type, id: String(cthread.ref_id) },
        author: subjectRef(comment.author_subject), visibility, url: visibility === 'hidden' ? null : `${config.baseUrl}/c/${encodeURIComponent(cthread.access_id)}`,
    }, { isPublic: visibility !== 'hidden', actor: actorOf(comment.author_subject) });
}

/**
 * A staff action on someone else's content: community.moderation.action, for the network's
 * moderation audit log (ADR-022). Call inside the same transaction as the change. Never the content.
 */
function moderationAction(v, action, target, { reason = null, details = {} } = {}) {
    const actorSubject = v && v.subject ? v.subject : null;
    const t = { type: target.type, id: String(target.id).slice(0, 200), ...(target.owner_subject !== undefined ? { owner_subject: target.owner_subject || null } : {}) };
    return record('community.moderation.action', { type: 'moderation_action', id: `${t.type}:${t.id}`.slice(0, 200) },
        { action, target: t, actor_subject: actorSubject, reason: reason ? String(reason).slice(0, 500) : null, details: details || {} },
        { actor: actorOf(actorSubject) || (v && v.service ? { type: 'service', id: String(v.service) } : null) });
}

function status() {
    if (!outbox) return { enabled: false };
    return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, last_error: stats.lastError };
}
/**
 * Graceful stop (server/index.js): no further sends; resolves when the send in progress has finished.
 * Rows written after this (a request that was still finishing) stay in the outbox for the next start.
 */
function stop() {
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = null;
    return outbox ? outbox.stop() : Promise.resolve();
}
function _reset() { if (outbox) outbox.stop(); outbox = null; stats.queued = 0; stats.lastError = null; }

module.exports = { init, record, moderationAction, pasteCreated, pasteUpdated, pasteDeleted, threadCreated, postCreated, commentCreated, status, stop, _reset };
