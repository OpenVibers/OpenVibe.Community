'use strict';

/**
 * Discord relay (DISCORD_RELAY_ENABLED; off by default), roadmap WS-J tasks 5 and 6.
 *
 * Out: a new thread in a public space with an enabled relay_mappings row is announced through the
 * mapping's Discord webhook; its replies follow (into the same channel, or the Discord thread the
 * mapping names); edits and deletes follow them through the external message map (relay_message_map).
 * In: with the gateway on, replies written on Discord come back as posts (server/relay/inbound.js).
 *
 * The queue is relay_deliveries, one row per dedupe key:
 *   create  thread:<id>:mapping:<m> | post:<id>:mapping:<m>    queued by the Events worker from
 *           community.thread.created / community.post.created (server/relay/events-worker.js), or by the
 *           forum itself while that worker is off
 *   edit    edit:<thread|post>:<id>:mapping:<m>:r<revision>     an edited opening post or reply that is on Discord
 *   delete  delete:<thread|post>:<id>:mapping:<m>               deleted, moderated away, or gated members-only
 * A create is POSTed with ?wait=true, so Discord answers with the message and its id goes into the map;
 * an edit or delete PATCHes or DELETEs /messages/<id> of the same webhook (?thread_id= when it was sent
 * into a Discord thread). Nothing already in the map is created twice, and a reply waits for its
 * thread's own message (a reply to a thread that is not on Discord through that mapping is skipped).
 *
 *   - Secrets never live in the database: a mapping stores webhook_url_ref, the NAME of an
 *     environment variable (e.g. DISCORD_WEBHOOK_FEEDBACK); the URL is read from process.env at
 *     send time. Only allow-listed names: DISCORD_RELAY_WEBHOOK_VARS (exact names) when set, else
 *     DISCORD_WEBHOOK_*. Staff can therefore never point the relay at the URL in some other
 *     variable (an internal service's base URL), nor learn which other variables are set; a
 *     mapping outside the list is refused when made and never sent.
 *   - Visibility: public spaces only, never members-only (VIP) spaces or threads, checked when
 *     queueing and again when sending. Gating a thread later deletes what the relay had sent.
 *   - Loop prevention: a thread or post whose origin is 'discord' is never relayed out, checked both
 *     when queueing and when sending (inbound.js adds the other half).
 *   - Retries: network errors, timeouts, 5xx, 429 and a missing webhook variable are retried with
 *     exponential backoff (baseMs · 2^(attempt−1), capped at an hour; a 429's retry_after is
 *     honoured, and the rest of that webhook's queue waits for the next pass) up to maxAttempts.
 *     Then the delivery is 'failed': the dead letter, with its error, that staff retry or drop.
 *     Other 4xx fail at once. A delete that finds the message already gone counts as delivered.
 *   - Mentions are disabled (allowed_mentions.parse = []), so nothing relayed can ping anyone.
 * Staff see and act on all of it at /api/v1/relay (relay/api.js).
 */
const pasteStore = require('../pastes/store');
const forumStore = require('../forum/store');
const { markdownToText } = require('../render/markdown');
const { sqlTime, isoTime } = require('../http/v1');
const { AI_DISPLAY_NAME } = require('../identity/authors');

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const WEBHOOK_VAR = /^DISCORD_WEBHOOK_[A-Z0-9_]+$/;
const SNOWFLAKE = /^\d{15,21}$/;
const MAX_BACKOFF_MS = 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;
const POSTS_PER_PAGE = 50;   // forum/service.js: a reply's link names its page
const UNKNOWN_MESSAGE = 10008;   // Discord's error code: the message is gone
const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dropped', 'skipped'];

/** Discord markdown in names/titles shown as plain text. */
const escapeDiscord = (s) => String(s || '').replace(/([\\*_~`|>#[\]])/g, '\\$1').replace(/@/g, '@\u200b');

/** webhookVars: exact allowed names, or null/empty for the DISCORD_WEBHOOK_* default. */
function createDiscordRelay({ db, config = {}, env = process.env, fetchImpl = globalThis.fetch, enabled = false, baseMs = 30_000, maxAttempts = 6, pollMs = 30_000, now = () => Date.now(), webhookVars = null } = {}) {
    const base = (config.baseUrl || '').replace(/\/$/, '');
    const allowed = Array.isArray(webhookVars) && webhookVars.length ? new Set(webhookVars) : null;
    /** May a mapping name this variable? */
    const refAllowed = (name) => typeof name === 'string' && ENV_NAME.test(name) && (allowed ? allowed.has(name) : WEBHOOK_VAR.test(name));
    let timer = null;
    let draining = null;
    let stopped = false;
    // While the Events worker runs it queues every create from the event stream; the forum's direct
    // calls then queue nothing (the dedupe keys would make them harmless anyway).
    let createsFromEvents = false;
    const parts = { worker: null, gateway: null, inbound: null };

    const keys = {
        create: (type, id, m) => `${type}:${id}:mapping:${m}`,
        edit: (type, id, m, rev) => `edit:${type}:${id}:mapping:${m}:r${rev}`,
        remove: (type, id, m) => `delete:${type}:${id}:mapping:${m}`,
    };
    /** Kept for callers of the first relay: the create key of a thread. */
    function deliveryKey(threadId, mappingId) { return keys.create('thread', threadId, mappingId); }

    const insertStmt = db.prepare(`INSERT INTO relay_deliveries (thread_id, post_id, mapping_id, action, dedupe_key, source, event_id, next_attempt_at)
                                   VALUES (@thread_id, @post_id, @mapping_id, @action, @key, @source, @event_id, @at) ON CONFLICT(dedupe_key) DO NOTHING`);
    function insert(row) {
        return insertStmt.run({ post_id: null, source: 'direct', event_id: null, ...row, at: sqlTime(now()) }).changes;
    }
    const outMappings = (spaceId) => db.prepare("SELECT * FROM relay_mappings WHERE space_id = ? AND direction = 'out' AND enabled = 1 ORDER BY id").all(spaceId);
    const mapRow = (mappingId, type, id) => db.prepare("SELECT * FROM relay_message_map WHERE platform = 'discord' AND mapping_id = ? AND local_type = ? AND local_id = ?").get(mappingId, type, id) || null;

    /** Why this thread (and a post of it) may not leave the site, or null. */
    function refusal(thread, space, post = null) {
        if (thread.origin === 'discord' || (post && post.origin === 'discord')) return `loop prevention: ${post && post.origin === 'discord' ? 'post' : 'thread'} came from Discord`;
        if (space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner) return 'the thread is no longer public (members-only or a restricted space)';
        return null;
    }
    /** Queue-time filter: the same rules, quietly. */
    const mayLeave = (thread, space, post = null) => !!(thread && space && !thread.deleted_at && !(post && post.deleted_at) && !refusal(thread, space, post));

    // ── queueing ─────────────────────────────────────────────
    /**
     * A new thread, for every enabled out-mapping of its space. source 'events' (the Events worker,
     * eventId) or 'direct' (the forum; ignored while the worker queues creates). → number queued
     */
    function enqueueThread(thread, space, { source = 'direct', eventId = null } = {}) {
        if (!enabled || !thread || !space) return 0;
        if (source === 'direct' && createsFromEvents) return 0;
        if (!mayLeave(thread, space)) return 0;
        let queued = 0;
        for (const m of outMappings(space.id)) {
            queued += insert({ thread_id: thread.id, mapping_id: m.id, action: 'create', key: keys.create('thread', thread.id, m.id), source, event_id: eventId });
        }
        if (queued) kick();
        return queued;
    }

    /**
     * A new reply: to every mapping its thread went to (sent, or still waiting to be). The opening post
     * travels with its thread. → number queued
     */
    function enqueuePost(post, thread, space, { source = 'direct', eventId = null } = {}) {
        if (!enabled || !post || !thread || !space || post.is_opening) return 0;
        if (source === 'direct' && createsFromEvents) return 0;
        if (!mayLeave(thread, space, post)) return 0;
        let queued = 0;
        for (const m of outMappings(space.id)) {
            const parent = db.prepare("SELECT status FROM relay_deliveries WHERE dedupe_key = ? AND status IN ('pending', 'delivered')").get(keys.create('thread', thread.id, m.id));
            if (!parent && !mapRow(m.id, 'thread', thread.id)) continue;
            queued += insert({ thread_id: thread.id, post_id: post.id, mapping_id: m.id, action: 'create', key: keys.create('post', post.id, m.id), source, event_id: eventId });
        }
        if (queued) kick();
        return queued;
    }

    /**
     * An edited post: the Discord message showing it (the thread's, for an opening post) is edited.
     * Only what is already on Discord; a create still waiting carries the new text anyway.
     */
    function enqueueEdit(post) {
        if (!enabled || !post) return 0;
        const type = post.is_opening ? 'thread' : 'post';
        const id = post.is_opening ? post.thread_id : post.id;
        const rows = db.prepare("SELECT * FROM relay_message_map WHERE platform = 'discord' AND direction = 'out' AND local_type = ? AND local_id = ? AND external_deleted_at IS NULL").all(type, id);
        let queued = 0;
        for (const r of rows) {
            queued += insert({ thread_id: post.thread_id, post_id: post.is_opening ? null : post.id, mapping_id: r.mapping_id, action: 'edit', key: keys.edit(type, id, r.mapping_id, post.revision) });
        }
        if (queued) kick();
        return queued;
    }

    /**
     * A thread (postId null: with every reply of it) or one reply left the public site — deleted,
     * moderated away or gated members-only: what is still waiting is skipped and what Discord shows is
     * deleted. Queued even while the relay is off, so it happens once it is on again.
     */
    function enqueueDelete(threadId, postId = null, reason = 'deleted') {
        const note = `skipped: ${reason} before it was sent`;
        return db.transaction(() => {
            if (postId == null) {
                db.prepare("UPDATE relay_deliveries SET status = 'skipped', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE thread_id = ? AND status = 'pending' AND action <> 'delete'").run(note, threadId);
            } else {
                db.prepare("UPDATE relay_deliveries SET status = 'skipped', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE post_id = ? AND status = 'pending' AND action <> 'delete'").run(note, postId);
            }
            const rows = postId == null
                ? db.prepare("SELECT * FROM relay_message_map WHERE thread_id = ? AND direction = 'out' AND external_deleted_at IS NULL").all(threadId)
                : db.prepare("SELECT * FROM relay_message_map WHERE local_type = 'post' AND local_id = ? AND direction = 'out' AND external_deleted_at IS NULL").all(postId);
            let queued = 0;
            for (const r of rows) {
                queued += insert({ thread_id: r.thread_id, post_id: r.local_type === 'post' ? r.local_id : null, mapping_id: r.mapping_id, action: 'delete', key: keys.remove(r.local_type, r.local_id, r.mapping_id) });
            }
            if (queued && enabled) kick();
            return queued;
        })();
    }
    /** Threads gated members-only (or otherwise no longer public): take them off Discord. */
    function hideThreads(threadIds, reason = 'made members-only') {
        let n = 0;
        for (const id of threadIds) n += enqueueDelete(id, null, reason);
        return n;
    }

    function kick() { setImmediate(() => { drain().catch((err) => console.warn('[Relay] drain failed:', err.message)); }); }

    // ── messages ─────────────────────────────────────────────
    function authorName(subject, origin) {
        if (origin === 'ai') return AI_DISPLAY_NAME;
        if (origin === 'system' && !subject) return 'OpenVibe';
        if (subject) {
            const p = pasteStore.getProjections(db, [subject]).get(subject);
            if (p) return p.display_name || p.username || 'someone';
        }
        return 'someone';
    }
    const threadUrl = (thread, space) => `${base}/s/${space.slug}/t/${thread.slug}`;
    function postUrl(post, thread, space) {
        const position = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id <= ?').get(thread.id, post.id).c;
        const page = Math.max(Math.ceil(position / POSTS_PER_PAGE), 1);
        return `${threadUrl(thread, space)}${page > 1 ? `?page=${page}` : ''}#post-${post.id}`;
    }

    /** The thread's message: who started it, the title, an excerpt of the opening post, the link. */
    function message(thread, space) {
        const opening = db.prepare('SELECT body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1').get(thread.id);
        const url = threadUrl(thread, space);
        return {
            username: 'OpenVibe.Community',
            content: `New thread in **s/${escapeDiscord(space.slug)}** by ${escapeDiscord(authorName(thread.author_subject, thread.origin))}: <${url}>`,
            allowed_mentions: { parse: [] },
            embeds: [{
                title: String(thread.title).slice(0, 256),
                url,
                description: markdownToText(opening ? opening.body_markdown : '', 300),
                footer: { text: `OpenVibe.Community · s/${space.slug}` },
                timestamp: isoTime(thread.created_at) || undefined,
            }],
        };
    }

    /** A reply's message: who replied to which thread, an excerpt, the link to the post. */
    function postMessage(post, thread, space) {
        const url = postUrl(post, thread, space);
        const title = String(thread.title).slice(0, 200);
        return {
            username: 'OpenVibe.Community',
            content: `${escapeDiscord(authorName(post.author_subject, post.origin))} replied to **${escapeDiscord(title)}** in **s/${escapeDiscord(space.slug)}**: <${url}>`,
            allowed_mentions: { parse: [] },
            embeds: [{
                title: `Re: ${title}`.slice(0, 256),
                url,
                description: markdownToText(post.body_markdown, 500),
                footer: { text: `OpenVibe.Community · s/${space.slug}` },
                timestamp: isoTime(post.created_at) || undefined,
            }],
        };
    }

    // ── sending ──────────────────────────────────────────────
    function backoff(attempts, retryAfterSec) {
        const exp = Math.min(baseMs * Math.pow(2, Math.max(attempts - 1, 0)), MAX_BACKOFF_MS);
        return Math.max(exp, retryAfterSec ? retryAfterSec * 1000 : 0);
    }

    /** One send happened: delivered, retried later, or failed (the dead letter). */
    function record(d, { ok, status = null, error = null, retry = false, retryAfter = 0, note = null }) {
        const attempts = d.attempts + 1;
        if (ok) {
            db.prepare("UPDATE relay_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = ?, delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(attempts, status, note, d.id);
            return 'delivered';
        }
        const giveUp = !retry || attempts >= maxAttempts;
        db.prepare('UPDATE relay_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(giveUp ? 'failed' : 'pending', attempts, status, String(error || '').slice(0, 500), sqlTime(now() + (giveUp ? 0 : backoff(attempts, retryAfter))), d.id);
        return giveUp ? 'failed' : 'retry';
    }
    /** Nothing was sent: already done (delivered) or nothing left to do (skipped). */
    function settle(d, status, reason) {
        db.prepare(`UPDATE relay_deliveries SET status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP,
                    delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END WHERE id = ?`).run(status, reason, status, d.id);
        return status === 'delivered' ? 'delivered' : 'skipped';
    }
    /** Not yet (a reply waiting for its thread's message): later, without using an attempt. */
    function defer(d, untilSql, reason) {
        const until = Math.max(Date.parse(`${String(untilSql || '').replace(' ', 'T')}Z`) || 0, now() + 1000);
        db.prepare('UPDATE relay_deliveries SET next_attempt_at = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sqlTime(until), reason, d.id);
        return 'retry';
    }

    async function send(d) {
        const m = db.prepare('SELECT * FROM relay_mappings WHERE id = ?').get(d.mapping_id);
        const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(d.thread_id);
        const space = thread ? forumStore.getSpaceById(db, thread.space_id) : null;
        const post = d.post_id ? forumStore.getPost(db, d.post_id) : null;
        const type = d.post_id ? 'post' : 'thread';
        const localId = d.post_id || d.thread_id;
        const gone = !thread || thread.deleted_at || !space || (d.post_id && (!post || post.deleted_at));
        const mapped = mapRow(d.mapping_id, type, localId);

        if (d.action === 'create') {
            if (gone) return settle(d, 'skipped', `the ${type} was deleted before it was sent`);
            const why = refusal(thread, space, post);
            if (why) return record(d, { ok: false, error: why });
            if (mapped) return settle(d, 'delivered', 'already on Discord');
            if (type === 'post' && !mapRow(d.mapping_id, 'thread', thread.id)) {
                const parent = db.prepare('SELECT status, next_attempt_at FROM relay_deliveries WHERE dedupe_key = ?').get(keys.create('thread', thread.id, d.mapping_id));
                if (parent && parent.status === 'pending') return defer(d, parent.next_attempt_at, "waiting for the thread's own message");
                return settle(d, 'skipped', 'the thread is not on Discord through this mapping');
            }
        } else {
            if (!mapped || mapped.direction !== 'out') return settle(d, 'skipped', 'not on Discord');
            if (mapped.external_deleted_at) return settle(d, 'skipped', 'already deleted on Discord');
            if (d.action === 'edit') {
                if (gone) return settle(d, 'skipped', `the ${type} was deleted`);
                const why = refusal(thread, space, post);
                if (why) return settle(d, 'skipped', why);
            }
        }

        if (!m || !refAllowed(m.webhook_url_ref)) return record(d, { ok: false, error: 'webhook_url_ref is not an allowed webhook variable' });
        const raw = env[m.webhook_url_ref];
        if (!raw) return record(d, { ok: false, retry: true, error: `webhook URL variable ${m.webhook_url_ref} is not set` });
        let url = null;
        try { url = new URL(raw); } catch { /* below */ }
        if (!url || !/^https?:$/.test(url.protocol)) return record(d, { ok: false, error: `${m.webhook_url_ref} is not an http(s) URL` });

        let method = 'POST';
        let body = null;
        let threadTarget = null;
        if (d.action === 'create') {
            threadTarget = (SNOWFLAKE.test(m.discord_thread_id || '') ? m.discord_thread_id : null) || url.searchParams.get('thread_id') || null;
            url.searchParams.set('wait', 'true');
            if (threadTarget) url.searchParams.set('thread_id', threadTarget);
            body = type === 'thread' ? message(thread, space) : postMessage(post, thread, space);
        } else {
            method = d.action === 'edit' ? 'PATCH' : 'DELETE';
            url.pathname = `${url.pathname.replace(/\/+$/, '')}/messages/${mapped.external_message_id}`;
            url.search = '';
            if (mapped.external_thread_id) url.searchParams.set('thread_id', mapped.external_thread_id);
            if (d.action === 'edit') body = type === 'thread' ? message(thread, space) : postMessage(post, thread, space);
        }

        let res;
        try {
            res = await fetchImpl(url.toString(), {
                method,
                headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), 'User-Agent': 'OpenVibe.Community relay' },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
        } catch (err) {
            return record(d, { ok: false, retry: true, error: err.name === 'TimeoutError' ? 'timed out' : err.message });
        }
        let answer = null;
        if (res.status !== 204) { try { answer = await res.json(); } catch { /* no JSON */ } }
        if (res.ok) {
            if (d.action === 'create') return created(d, res.status, answer, { type, localId, threadTarget, mapping: m });
            if (d.action === 'delete') db.prepare('UPDATE relay_message_map SET external_deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mapped.id);
            else db.prepare('UPDATE relay_message_map SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mapped.id);
            return record(d, { ok: true, status: res.status });
        }
        // The message itself is gone on Discord (someone deleted it there): a delete is done, an edit has nothing to edit.
        if (res.status === 404 && d.action !== 'create' && answer && Number(answer.code) === UNKNOWN_MESSAGE) {
            db.prepare('UPDATE relay_message_map SET external_deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(mapped.id);
            return d.action === 'delete' ? record(d, { ok: true, status: 404, note: 'the message was already gone on Discord' }) : settle(d, 'skipped', 'the message is gone on Discord');
        }
        const detail = answer && (answer.message || answer.error) ? String(answer.message || answer.error) : '';
        let retryAfter = Number(res.headers.get('retry-after')) || 0;
        if (answer && answer.retry_after) retryAfter = Math.max(retryAfter, Number(answer.retry_after) || 0);
        const retry = res.status === 429 || res.status === 408 || res.status >= 500;
        const outcome = record(d, { ok: false, retry, retryAfter, status: res.status, error: `Discord answered ${res.status}${detail ? `: ${detail}` : ''}` });
        return res.status === 429 ? { outcome, rateLimited: true } : outcome;
    }

    /** A create was answered: map the message (both ways unique) and learn the mapping's channel. */
    function created(d, status, msg, { type, localId, threadTarget, mapping }) {
        const id = msg && SNOWFLAKE.test(String(msg.id || '')) ? String(msg.id) : null;
        const channel = msg && SNOWFLAKE.test(String(msg.channel_id || '')) ? String(msg.channel_id) : null;
        if (!id || !channel) return record(d, { ok: true, status, note: 'Discord did not answer with the message, so edits and deletes cannot follow it' });
        return db.transaction(() => {
            db.prepare(`INSERT INTO relay_message_map (platform, mapping_id, direction, local_type, local_id, thread_id, external_channel_id, external_thread_id, external_message_id, external_webhook_id)
                        VALUES ('discord', ?, 'out', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
                .run(mapping.id, type, localId, d.thread_id, channel, threadTarget ? channel : null, id, msg.webhook_id ? String(msg.webhook_id) : null);
            if (!threadTarget) db.prepare('UPDATE relay_mappings SET discord_channel_id = ? WHERE id = ? AND discord_channel_id IS NULL').run(channel, mapping.id);
            return record(d, { ok: true, status });
        })();
    }

    /**
     * Send every due delivery once, oldest first. One drain at a time. A 429 leaves the rest of that
     * webhook's queue for the next pass. → { delivered, retry, failed, skipped }
     */
    function drain() {
        if (draining) return draining;
        if (stopped) return Promise.resolve({ delivered: 0, retry: 0, failed: 0, skipped: 0 });
        draining = (async () => {
            const summary = { delivered: 0, retry: 0, failed: 0, skipped: 0 };
            if (!enabled) return summary;
            // Deletes go out even for a disabled mapping: what left the site leaves Discord too.
            const due = db.prepare(`SELECT d.* FROM relay_deliveries d JOIN relay_mappings m ON m.id = d.mapping_id
                                    WHERE d.status = 'pending' AND (m.enabled = 1 OR d.action = 'delete') AND d.next_attempt_at <= ?
                                    ORDER BY d.id ASC LIMIT 50`).all(sqlTime(now()));
            const paused = new Set();
            for (const d of due) {
                if (stopped) break;
                if (paused.has(d.mapping_id)) continue;
                const r = await send(d);
                if (r && typeof r === 'object') { paused.add(d.mapping_id); summary[r.outcome]++; } else summary[r]++;
            }
            return summary;
        })().finally(() => { draining = null; });
        return draining;
    }

    // ── lifecycle ────────────────────────────────────────────
    /** The Events worker, the gateway and the inbound handler (app.js), started and stopped with the relay. */
    function attach({ worker = null, gateway = null, inbound = null } = {}) { Object.assign(parts, { worker, gateway, inbound }); }
    /** The Events worker says it queues creates (true) or no longer does. */
    function useEventsForCreates(on) { createsFromEvents = !!on; }

    function start() {
        if (!enabled || timer) return;
        stopped = false;
        timer = setInterval(() => { drain().catch((err) => console.warn('[Relay] drain failed:', err.message)); }, pollMs);
        if (timer.unref) timer.unref();
        kick();
        if (parts.worker) parts.worker.start();
        if (parts.gateway) parts.gateway.start();
    }
    /** Graceful stop: no further drains or reads; resolves when the drain and page in progress finished (the rest stay queued). */
    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        const waits = [draining || Promise.resolve()];
        if (parts.worker) waits.push(parts.worker.stop());
        if (parts.gateway) waits.push(parts.gateway.stop());
        return Promise.all(waits).then(() => undefined);
    }

    // ── admin (staff) ────────────────────────────────────────
    function shapeMapping(m) {
        return {
            id: m.id, space: m.space_slug, direction: m.direction, webhook_url_ref: m.webhook_url_ref, webhook_configured: refAllowed(m.webhook_url_ref) && !!env[m.webhook_url_ref],
            enabled: !!m.enabled, discord_channel_id: m.discord_channel_id || null, discord_thread_id: m.discord_thread_id || null, inbound: !!m.inbound, created_at: isoTime(m.created_at),
        };
    }
    const mappingQuery = 'SELECT m.*, s.slug AS space_slug FROM relay_mappings m JOIN spaces s ON s.id = m.space_id';
    function listMappings() { return db.prepare(`${mappingQuery} ORDER BY m.id`).all().map(shapeMapping); }
    const snowflakeOrNull = (v, name) => {
        if (v === undefined) return undefined;
        if (v === null || v === '') return null;
        if (!SNOWFLAKE.test(String(v))) throw new Error(`${name} is a Discord id (digits)`);
        return String(v);
    };
    /** { space_id, webhook_url_ref, enabled?, discord_channel_id?, discord_thread_id?, inbound? } → mapping (made, or updated) */
    function addMapping({ space_id, webhook_url_ref, enabled: on = true, discord_channel_id, discord_thread_id, inbound }) {
        if (!refAllowed(webhook_url_ref)) throw new Error(`${webhook_url_ref} is not an allowed webhook variable`);
        const channel = snowflakeOrNull(discord_channel_id, 'discord_channel_id');
        const thread = snowflakeOrNull(discord_thread_id, 'discord_thread_id');
        db.prepare(`INSERT INTO relay_mappings (space_id, direction, webhook_url_ref, enabled, discord_channel_id, discord_thread_id, inbound) VALUES (?, 'out', ?, ?, ?, ?, ?)
                    ON CONFLICT(space_id, direction, webhook_url_ref) DO UPDATE SET enabled = excluded.enabled`).run(space_id, webhook_url_ref, on ? 1 : 0, channel || null, thread || null, inbound ? 1 : 0);
        const row = db.prepare(`${mappingQuery} WHERE m.space_id = ? AND m.direction = 'out' AND m.webhook_url_ref = ?`).get(space_id, webhook_url_ref);
        return updateMapping(row.id, { discord_channel_id: channel, discord_thread_id: thread, inbound });
    }
    /** { enabled?, inbound?, discord_channel_id?, discord_thread_id? } → mapping, or null when there is no such mapping */
    function updateMapping(id, fields = {}) {
        const sets = [];
        const params = [];
        if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
        if (fields.inbound !== undefined) { sets.push('inbound = ?'); params.push(fields.inbound ? 1 : 0); }
        for (const k of ['discord_channel_id', 'discord_thread_id']) {
            const v = snowflakeOrNull(fields[k], k);
            if (v !== undefined) { sets.push(`${k} = ?`); params.push(v); }
        }
        if (sets.length && !db.prepare(`UPDATE relay_mappings SET ${sets.join(', ')} WHERE id = ?`).run(...params, id).changes) return null;
        const row = db.prepare(`${mappingQuery} WHERE m.id = ?`).get(id);
        return row ? shapeMapping(row) : null;
    }
    function setMappingEnabled(id, on) { return updateMapping(id, { enabled: on }); }

    function listDeliveries({ status = null, action = null, limit = 50 } = {}) {
        return db.prepare(`SELECT d.*, m.webhook_url_ref, t.title AS thread_title, t.slug AS thread_slug, s.slug AS space_slug
                           FROM relay_deliveries d JOIN relay_mappings m ON m.id = d.mapping_id JOIN threads t ON t.id = d.thread_id JOIN spaces s ON s.id = t.space_id
                           WHERE (? IS NULL OR d.status = ?) AND (? IS NULL OR d.action = ?) ORDER BY d.id DESC LIMIT ?`).all(status, status, action, action, limit)
            .map((d) => ({
                id: d.id, dedupe_key: d.dedupe_key, action: d.action, source: d.source, event_id: d.event_id || null,
                status: d.status, attempts: d.attempts, last_status: d.last_status, last_error: d.last_error,
                next_attempt_at: d.status === 'pending' ? isoTime(d.next_attempt_at) : null, delivered_at: isoTime(d.delivered_at), created_at: isoTime(d.created_at), updated_at: isoTime(d.updated_at),
                mapping: { id: d.mapping_id, webhook_url_ref: d.webhook_url_ref },
                thread: { id: d.thread_id, title: d.thread_title, url: `/s/${d.space_slug}/t/${d.thread_slug}` },
                post: d.post_id ? { id: d.post_id } : null,
            }));
    }
    /** Put a delivery that was not delivered back in the queue now, with a fresh attempt budget. */
    function retry(id) {
        const n = db.prepare("UPDATE relay_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'delivered'").run(sqlTime(now()), id).changes;
        if (n) kick();
        return n;
    }
    /** Staff give up on a waiting or dead delivery: 'dropped', kept for the record. */
    function drop(id) {
        return db.prepare("UPDATE relay_deliveries SET status = 'dropped', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'failed')").run(id).changes;
    }

    /** What staff (and /api/ready) see: the queue by status, and the Events worker's and the gateway's state. */
    function status() {
        const deliveries = Object.fromEntries(DELIVERY_STATUSES.map((s) => [s, 0]));
        for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM relay_deliveries GROUP BY status').all()) deliveries[r.status] = r.n;
        const off = (reason) => ({ enabled: false, reason });
        return {
            enabled,
            creates_from: createsFromEvents ? 'events' : 'forum',
            deliveries,
            dead_letters: deliveries.failed,
            messages_mapped: db.prepare('SELECT COUNT(*) AS n FROM relay_message_map WHERE external_deleted_at IS NULL').get().n,
            events_worker: parts.worker ? parts.worker.status() : off(enabled ? 'not configured' : 'the relay is off'),
            inbound: parts.gateway ? { ...parts.gateway.status(), ...(parts.inbound ? { handled: parts.inbound.stats() } : {}) } : off(enabled ? 'DISCORD_RELAY_INBOUND is off' : 'the relay is off'),
            inbound_failures: db.prepare('SELECT COUNT(*) AS n FROM relay_inbound_failures WHERE dismissed_at IS NULL').get().n,
        };
    }

    return {
        enabled, enqueueThread, enqueuePost, enqueueEdit, enqueueDelete, hideThreads, drain, start, stop, attach, useEventsForCreates, status,
        listMappings, addMapping, updateMapping, setMappingEnabled, listDeliveries, retry, drop, deliveryKey, ENV_NAME, refAllowed, message, postMessage,
    };
}

module.exports = { createDiscordRelay, escapeDiscord, ENV_NAME, WEBHOOK_VAR, SNOWFLAKE, DELIVERY_STATUSES };
