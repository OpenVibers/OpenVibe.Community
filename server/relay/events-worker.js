'use strict';

/**
 * The Discord relay's Events worker (roadmap WS-J task 6): reads Community's own
 * community.thread.* and community.post.* from OpenVibe.Events' pull API (GET /api/v1/events,
 * capability events.event.read, Community's service token on audience openvibe.events) and queues
 * the relay's creates from them (relay/discord.js).
 *
 *   - Cursor: the relay_cursors row 'discord-relay:events', moved in the same transaction as the
 *     deliveries its page queued. A crash replays at most the page in progress, and the dedupe keys
 *     make that replay queue nothing twice. `position` is Events' opaque cursor (the page's next_cursor),
 *     the place the worker reads on from; `cursor` is the numeric seq, still written while Events sends it
 *     (a worker of the previous release, and the lag shown to staff). A row with no position yet (written
 *     by the previous release) is read on from its numeric cursor once, and has a position from then on.
 *   - First start (no cursor yet): it begins at Events' head (latest_cursor). Threads from before are never
 *     announced.
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
    const readCursor = async () => await db.prepare('SELECT cursor, position, latest_seq FROM relay_cursors WHERE name = ?').get(CURSOR) || null;
    async function writeCursor(cursor, latest, position) {
        await db.prepare(`INSERT INTO relay_cursors (name, cursor, latest_seq, position, updated_at) VALUES (?, ?, ?, ?, ov_now())
                    ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor, latest_seq = excluded.latest_seq, position = excluded.position, updated_at = ov_now()`)
            .run(CURSOR, cursor, latest == null ? null : latest, position || null);
    }
    const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);

    /** One event → deliveries queued (0 when it is not for the relay). */
    async function handle(ev) {
        stats.seen++;
        if (!ev || ev.source !== 'community' || !ev.payload || ev.payload.redacted) return 0;
        const p = ev.payload;
        if (p.visibility && p.visibility !== 'public') return 0;
        if (ev.event_type === 'community.thread.created') {
            const thread = await db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(p.thread_id));
            const space = thread ? await forumStore.getSpaceById(db, thread.space_id) : null;
            return await relay.enqueueThread(thread, space, { source: 'events', eventId: ev.event_id || null });
        }
        if (ev.event_type === 'community.post.created') {
            const post = await forumStore.getPost(db, Number(p.post_id));
            const thread = post ? await db.prepare('SELECT * FROM threads WHERE id = ?').get(post.thread_id) : null;
            const space = thread ? await forumStore.getSpaceById(db, thread.space_id) : null;
            return await relay.enqueuePost(post, thread, space, { source: 'events', eventId: ev.event_id || null });
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
                let cur = await readCursor();
                if (!cur) {
                    // First start: Events' head, as an opaque cursor (the numeric seq beside it while Events sends one).
                    const head = await client.pull({ topic: TOPICS, limit: 1 });
                    const latest = num(head.latest_seq) || 0;
                    await writeCursor(latest, latest, head.latest_cursor || null);
                    stats.started_at_seq = latest;
                    console.log(`[Relay] Events worker starts at the head (seq ${latest}; earlier threads are not announced)`);
                    cur = { cursor: latest, position: head.latest_cursor || null, latest_seq: latest };
                }
                let cursor = num(cur.cursor) || 0;
                let position = cur.position || null;
                for (let pages = 0; pages < MAX_PAGES_PER_TICK && !stopped; pages++) {
                    // Read on from the opaque position; a row from the previous release has only the numeric cursor.
                    const page = position
                        ? await client.pull({ topic: TOPICS, after: position, limit: pageLimit })
                        : await client.pull({ topic: TOPICS, afterSeq: cursor, limit: pageLimit });
                    if (stopped) break;
                    if (page.gap) {
                        stats.last_gap = { from_seq: page.gap.from_seq, to_seq: page.gap.to_seq, at: iso() };
                        console.warn(`[Relay] Events gap: seq ${page.gap.from_seq}..${page.gap.to_seq} were pruned before the relay read them; threads and replies in it are not relayed`);
                    }
                    const nextPosition = page.next_cursor || position;
                    const next = num(page.next_after_seq);
                    const nextCursor = next != null && next > cursor ? next : cursor;
                    const latest = num(page.latest_seq);
                    const items = page.events || [];
                    queuedNow += await db.tx(async () => {
                        let n = 0;
                        for (const item of items) n += await handle(item && item.event);
                        await writeCursor(nextCursor, latest, nextPosition);
                        return n;
                    });
                    stats.pages++;
                    const moved = nextPosition !== position || nextCursor !== cursor;
                    position = nextPosition;
                    cursor = nextCursor;
                    // A short page means the read reached the head (next_cursor already moved past what did not match).
                    if (!moved || items.length < pageLimit) break;
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

    async function status() {
        if (!on) return { enabled: false, reason };
        const cur = await readCursor();
        return {
            enabled: true, running: !!timer, topics: TOPICS,
            cursor: cur ? cur.cursor : null, position: cur ? cur.position || null : null, latest_seq: cur ? cur.latest_seq : null,
            lag: cur && cur.latest_seq != null ? Math.max(cur.latest_seq - cur.cursor, 0) : null,
            events_seen: stats.seen, deliveries_queued: stats.queued, started_at_seq: stats.started_at_seq,
            last_ok_at: stats.last_ok_at, last_error: stats.last_error, last_error_at: stats.last_error_at, last_gap: stats.last_gap,
        };
    }

    return { enabled: on, reason, tick, start, stop, status, TOPICS, CURSOR };
}

module.exports = { createRelayEventsWorker, TOPICS, CURSOR };
