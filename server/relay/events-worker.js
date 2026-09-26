'use strict';

/**
 * The Discord relay's Events worker (roadmap WS-J task 6): reads Community's own
 * community.thread.* and community.post.* from OpenVibe.Events' pull API (GET /api/v1/events,
 * capability events.event.read, Community's service token on audience openvibe.events) and queues
 * the relay's creates from them (relay/discord.js).
 *
 *   - Cursor: the relay_cursors row 'discord-relay:events', moved in the same transaction as the
 *     deliveries its page queued. A crash replays at most the page in progress, and the dedupe keys
 *     make that replay queue nothing twice.
 *   - First start (no cursor yet): it begins at Events' head. Threads from before are never announced.
 *   - Events carry ids, never content: the worker reads the thread or post as it is now and the relay's
 *     rules decide (public spaces only, never members-only, never origin 'discord'). Redacted events
 *     and events from any other source are ignored.
 *   - A gap (retention pruned events the worker had not read yet) is logged and shown to staff; the
 *     creates in it are not relayed.
 *   - While it runs, the forum's own create calls queue nothing (the worker is the one path). Off
 *     without EVENTS_URL and OV_OAUTH_CLIENT_SECRET, or with DISCORD_RELAY_EVENTS=off: then the forum
 *     queues creates itself, as the first relay did. Edits and deletes are queued by the forum in both
 *     cases (Contracts has no community.thread/post update or delete events yet).
 */
const forumStore = require('../forum/store');

const TOPICS = ['community.thread.*', 'community.post.*'];
const CURSOR = 'discord-relay:events';
const MAX_PAGES_PER_TICK = 20;

/**
 * events: an openvibe-sdk events client (tests); otherwise one is made from eventsUrl, clientSecret and
 * tokenUrl (the Network's /oauth/token, client credentials of clientId).
 */
function createRelayEventsWorker({ db, relay, events = null, eventsUrl = null, clientSecret = null, tokenUrl = null, clientId = 'community', fetchImpl, enabled = true, pollMs = 5000, pageLimit = 100, now = () => Date.now() } = {}) {
    let reason = null;
    if (!relay || !relay.enabled) reason = 'the Discord relay is off (DISCORD_RELAY_ENABLED)';
    else if (!enabled) reason = 'DISCORD_RELAY_EVENTS=off';
    else if (!events && (!eventsUrl || !clientSecret || !tokenUrl)) reason = 'EVENTS_URL and OV_OAUTH_CLIENT_SECRET are not both set';
    let client = events;
    if (!reason && !client) {
        const { createClient } = require('openvibe-sdk/core');
        const { createServiceTokenClient } = require('openvibe-sdk/auth');
        const { createEventsClient } = require('openvibe-sdk/events');
        const tokens = createServiceTokenClient({ tokenUrl, clientId, clientSecret, fetch: fetchImpl });
        const core = createClient({ baseUrls: { events: String(eventsUrl).replace(/\/+$/, '') }, tokenProvider: tokens, fetch: fetchImpl, retries: 0 });
        client = createEventsClient(core, { source: 'community' });
    }
    const on = !reason;
    const stats = { seen: 0, queued: 0, pages: 0, last_error: null, last_error_at: null, last_ok_at: null, last_gap: null, started_at_seq: null };
    let timer = null;
    let running = null;
    let stopped = false;

    const iso = () => new Date(now()).toISOString();
    const readCursor = () => db.prepare('SELECT cursor, latest_seq FROM relay_cursors WHERE name = ?').get(CURSOR) || null;
    function writeCursor(cursor, latest) {
        db.prepare(`INSERT INTO relay_cursors (name, cursor, latest_seq, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor, latest_seq = excluded.latest_seq, updated_at = CURRENT_TIMESTAMP`).run(CURSOR, cursor, latest == null ? null : latest);
    }

    /** One event → deliveries queued (0 when it is not for the relay). */
    function handle(ev) {
        stats.seen++;
        if (!ev || ev.source !== 'community' || !ev.payload || ev.payload.redacted) return 0;
        const p = ev.payload;
        if (p.visibility && p.visibility !== 'public') return 0;
        if (ev.event_type === 'community.thread.created') {
            const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(p.thread_id));
            const space = thread ? forumStore.getSpaceById(db, thread.space_id) : null;
            return relay.enqueueThread(thread, space, { source: 'events', eventId: ev.event_id || null });
        }
        if (ev.event_type === 'community.post.created') {
            const post = forumStore.getPost(db, Number(p.post_id));
            const thread = post ? db.prepare('SELECT * FROM threads WHERE id = ?').get(post.thread_id) : null;
            const space = thread ? forumStore.getSpaceById(db, thread.space_id) : null;
            return relay.enqueuePost(post, thread, space, { source: 'events', eventId: ev.event_id || null });
        }
        return 0;
    }

    /** Read everything new (at most MAX_PAGES_PER_TICK pages). One tick at a time. */
    function tick() {
        if (!on) return Promise.resolve({ queued: 0 });
        if (running) return running;
        running = (async () => {
            let queuedNow = 0;
            try {
                let cur = readCursor();
                if (!cur) {
                    const head = await client.pull({ topic: TOPICS, afterSeq: 0, limit: 1 });
                    const latest = Number(head.latest_seq) || 0;
                    writeCursor(latest, latest);
                    stats.started_at_seq = latest;
                    console.log(`[Relay] Events worker starts at seq ${latest} (earlier threads are not announced)`);
                    cur = { cursor: latest, latest_seq: latest };
                }
                let cursor = Number(cur.cursor) || 0;
                for (let pages = 0; pages < MAX_PAGES_PER_TICK && !stopped; pages++) {
                    const page = await client.pull({ topic: TOPICS, afterSeq: cursor, limit: pageLimit });
                    if (stopped) break;
                    if (page.gap) {
                        stats.last_gap = { from_seq: page.gap.from_seq, to_seq: page.gap.to_seq, at: iso() };
                        console.warn(`[Relay] Events gap: seq ${page.gap.from_seq}..${page.gap.to_seq} were pruned before the relay read them; threads and replies in it are not relayed`);
                    }
                    const next = Number(page.next_after_seq);
                    const latest = Number(page.latest_seq);
                    const moved = Number.isFinite(next) && next > cursor ? next : cursor;
                    queuedNow += db.transaction(() => {
                        let n = 0;
                        for (const item of page.events || []) n += handle(item && item.event);
                        writeCursor(moved, Number.isFinite(latest) ? latest : null);
                        return n;
                    })();
                    stats.pages++;
                    if (moved === cursor || !Number.isFinite(latest) || moved >= latest) break;
                    cursor = moved;
                }
                stats.queued += queuedNow;
                stats.last_ok_at = iso();
                if (stats.last_error) console.log('[Relay] Events worker reading again');
                stats.last_error = null;
                stats.last_error_at = null;
            } catch (err) {
                const m = err && err.message ? err.message : String(err);
                if (m !== stats.last_error) console.warn('[Relay] Events worker cannot read (will retry):', m);
                stats.last_error = m;
                stats.last_error_at = iso();
            }
            return { queued: queuedNow };
        })().finally(() => { running = null; });
        return running;
    }

    function start() {
        if (!on || timer) return;
        stopped = false;
        relay.useEventsForCreates(true);
        timer = setInterval(() => { tick(); }, pollMs);
        if (timer.unref) timer.unref();
        tick();
    }
    /** Graceful stop: no further reads; resolves when the page in progress has been handled. */
    function stop() {
        stopped = true;
        if (timer) clearInterval(timer);
        timer = null;
        return running ? running.then(() => undefined) : Promise.resolve();
    }

    function status() {
        if (!on) return { enabled: false, reason };
        const cur = readCursor();
        return {
            enabled: true, running: !!timer, topics: TOPICS,
            cursor: cur ? cur.cursor : null, latest_seq: cur ? cur.latest_seq : null,
            lag: cur && cur.latest_seq != null ? Math.max(cur.latest_seq - cur.cursor, 0) : null,
            events_seen: stats.seen, deliveries_queued: stats.queued, started_at_seq: stats.started_at_seq,
            last_ok_at: stats.last_ok_at, last_error: stats.last_error, last_error_at: stats.last_error_at, last_gap: stats.last_gap,
        };
    }

    return { enabled: on, reason, tick, start, stop, status, TOPICS, CURSOR };
}

module.exports = { createRelayEventsWorker, TOPICS, CURSOR };
