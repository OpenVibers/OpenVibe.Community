'use strict';

/**
 * Pulse sources — the public activity that has no Events topic of its own, read on a due basis.
 *
 * The feed never calls another site while a person is reading it (server/pulse/feed.js reads Pulse only). This job
 * fills Pulse from the public APIs:
 *   - OpenVibe.Today: GET /api/v1/events (public, cached there) → source today / event
 *   - OpenVibe.Network: GET /api/v1/stats (public, CORS-open) → one grouped member row per day, "5 people joined today"
 *   - OpenVibe.Quest: GET /api/v1/profiles/:subject/badges for people recently active in Pulse → "Finished a quest: …"
 *   - OpenVibe.Meme: GET /api/v1/entries (public) → newly published meme entries
 *
 * Due-ness is kept in the database (pulse_source_runs): a run records the next time it is due, so a restart does not
 * skip a source and two processes do not both fetch at once (the second simply finds it not due). A minute timer only
 * checks those rows; nothing here runs per feed request. Wiki pages and Chat are pushed by Events and handled in
 * server/pulse/consumer.js; no route or page is slowed by this job.
 */
const store = require('./store');
const { sqlTime } = require('../http/v1');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const QUEST_CHECK_MS = 24 * 60 * MINUTE;
const QUEST_RECENT_MS = 14 * DAY;

const clean = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const https = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const subject = (v) => (/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(v || '')) ? String(v) : null);
const sqlFrom = (v, fallback) => {
    const normalized = store.pulseTime(v);
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(normalized || '')) ? normalized : fallback;
};
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function createPulseSources({ db, config = {}, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const todayApi = String(config.todayInternalUrl || config.todayUrl || 'https://openvibe.today').replace(/\/+$/, '');
    const todaySite = String(config.todayUrl || 'https://openvibe.today').replace(/\/+$/, '');
    const networkApi = String(config.networkInternalUrl || config.networkUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const networkSite = String(config.networkUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const questApi = String(config.questInternalUrl || config.questUrl || 'https://openvibe.quest').replace(/\/+$/, '');
    const questSite = String(config.questUrl || 'https://openvibe.quest').replace(/\/+$/, '');
    const memeApi = String(config.memeInternalUrl || config.memeUrl || 'https://openvibe.meme').replace(/\/+$/, '');
    const liveApi = String(config.liveUrl || 'https://openvibe.live').replace(/\/+$/, '');
    let timer = null;
    let running = null;

    async function getJson(url, { timeoutMs = 8000 } = {}) {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`${url} answered ${res.status}`);
        return await res.json();
    }

    /** OpenVibe.Today's public calendar → one event row per scheduled stream or event. */
    async function todayEvents() {
        const at = now();
        const from = new Date(at).toISOString();
        const to = new Date(at + 60 * DAY).toISOString();
        const out = await getJson(`${todayApi}/api/v1/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`);
        let n = 0;
        for (const e of (Array.isArray(out.events) ? out.events : [])) {
            if (!e || typeof e.id !== 'string' || !e.id || typeof e.title !== 'string' || !e.title.trim()) continue;
            if (e.visibility !== 'public' || e.status === 'cancelled') continue;
            const starts = Date.parse(String(e.starts_at || ''));
            if (!Number.isFinite(starts) || starts <= at) continue;
            const owner = subject(e.owner_subject);
            const whenLabel = `Starts ${new Date(starts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
            const text = [whenLabel, clean(e.description, 220)].filter(Boolean).join(' · ');
            const when = sqlFrom(e.created_at, sqlTime(at));
            const out2 = await store.upsertItem(db, {
                source_service: 'today', source_type: 'event', source_id: e.id,
                title: `Coming up: ${clean(e.title, 140)}`,
                url: https(e.url) || `${todaySite}/e/${encodeURIComponent(e.id)}`,
                actor_subject: owner, origin: owner ? 'user' : 'system', occurred_at: when, starts_at: e.starts_at, text,
            });
            if (out2.created) n++;
        }
        return n;
    }

    /** OpenVibe.Network's open stats → one grouped member row per UTC day ("5 people joined today"). */
    async function networkMembers() {
        const at = now();
        const out = await getJson(`${networkApi}/api/v1/stats?days=7`);
        const accounts = out && out.accounts;
        if (!accounts || !Array.isArray(accounts.daily)) return 0;
        const today = dayOf(at);
        const total = Number(accounts.total);
        let n = 0;
        for (const d of accounts.daily) {
            const count = Number(d && d.n);
            const day = String((d && d.day) || '');
            if (!Number.isInteger(count) || count <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            const title = day === today
                ? `${count} ${count === 1 ? 'person' : 'people'} joined today`
                : `${count} ${count === 1 ? 'person' : 'people'} joined on ${day}`;
            const r = await store.upsertItem(db, {
                source_service: 'network', source_type: 'members', source_id: day,
                title, url: `${networkSite}/stats`, actor_subject: null, origin: 'system',
                occurred_at: day === today ? sqlTime(at) : `${day}T12:00:00Z`,
                text: Number.isFinite(total) && total > 0 ? `${total.toLocaleString('en-US')} people on OpenVibe so far` : '',
            });
            if (r.created) n++;
        }
        return n;
    }

    /**
     * Quest badges for people recently active in Pulse: the public badges API is the only read Quest offers, so a
     * rotation (a person is checked at most once a day) finds "Finished a quest: …". Nothing is stored about anyone
     * but their subject and when the check ran.
     */
    async function questBadges() {
        const at = now();
        const since = sqlTime(at - QUEST_RECENT_MS);
        const checkedBefore = sqlTime(at - QUEST_CHECK_MS);
        const people = await db.prepare(`SELECT DISTINCT i.actor_subject AS subject FROM pulse_items i
            LEFT JOIN pulse_quest_people q ON q.subject = i.actor_subject
            WHERE i.actor_subject IS NOT NULL AND i.origin = 'user' AND i.occurred_at >= ?
              AND (q.subject IS NULL OR q.checked_at < ?)
            ORDER BY i.actor_subject LIMIT 25`).all(since, checkedBefore);
        let n = 0;
        const MAX_CREATED = 25;
        for (const p of people) {
            if (n >= MAX_CREATED) break;
            const who = subject(p.subject);
            if (!who) continue;
            try {
                const res = await fetchImpl(`${questApi}/api/v1/profiles/${encodeURIComponent(who)}/badges`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
                if (res.ok) {
                    const body = await res.json();
                    const recent = (Array.isArray(body.badges) ? body.badges : [])
                        .filter((b) => b && typeof b.id === 'string' && b.id && typeof b.name === 'string' && b.name.trim())
                        .map((b) => ({ ...b, awarded: Date.parse(String(b.awarded_at || '')) }))
                        .filter((b) => Number.isFinite(b.awarded) && at - b.awarded <= QUEST_RECENT_MS)
                        .sort((a, b) => b.awarded - a.awarded)
                        .slice(0, 2);
                    for (const b of recent) {
                        if (n >= MAX_CREATED) break;
                        const awarded = b.awarded;
                        const r = await store.upsertItem(db, {
                            source_service: 'quest', source_type: 'badge', source_id: `${who}:${b.id}`,
                            title: `Finished a quest: ${clean(b.name, 90)}`, url: `${questSite}/`,
                            actor_subject: who, origin: 'user', occurred_at: sqlTime(awarded), text: '',
                        });
                        if (r.created) n++;
                    }
                }
            } catch (err) {
                log.warn?.(`[Pulse sources] Quest ${who}:`, err.message);
            }
            await db.prepare(`INSERT INTO pulse_quest_people (subject, checked_at) VALUES (?, ?)
                ON CONFLICT(subject) DO UPDATE SET checked_at = excluded.checked_at`).run(who, sqlTime(at));
        }
        return n;
    }

    /** Meme's public entries → one Feed card each; the API excludes hidden and unlisted entries. */
    async function memeEntries() {
        let cursor = null, created = 0;
        for (let page = 0; page < 4; page++) {
            const url = new URL('/api/v1/entries', memeApi);
            url.searchParams.set('limit', '50');
            if (cursor) url.searchParams.set('cursor', cursor);
            const out = await getJson(url.toString());
            for (const e of (Array.isArray(out.entries) ? out.entries : [])) {
                const slug = clean(e && e.slug, 100);
                const title = clean(e && e.title, 300);
                if (!slug || !/^[A-Za-z0-9-]+$/.test(slug) || !title) continue;
                const url = `${String(config.memeUrl || 'https://openvibe.meme').replace(/\/+$/, '')}/m/${encodeURIComponent(slug)}`;
                const r = await store.upsertItem(db, {
                    source_service: 'meme', source_type: 'meme', source_id: slug, title, url,
                    actor_subject: null, origin: 'system', occurred_at: sqlFrom(e.published_at || e.created_at, sqlTime(now())),
                    text: clean(e.summary || e.description, 280),
                });
                if (r.created) created++;
            }
            cursor = typeof out.next_cursor === 'string' && out.next_cursor ? out.next_cursor : null;
            if (!cursor) break;
        }
        return created;
    }

    /** The anonymous Rundown browse response contains only episodes visible to everyone. */
    async function rundownEpisodes() {
        let before = null, created = 0;
        const seen = new Set();
        for (let page = 0; page < 50; page++) {
            const url = new URL('/api/rundown/streams', liveApi);
            if (before) url.searchParams.set('before', before);
            const out = await getJson(url.toString());
            for (const s of (Array.isArray(out.streams) ? out.streams : [])) {
                if (!s || s.live || !s.episode || s.episode.audience !== 'public' || !Number.isSafeInteger(Number(s.stream_id)) || Number(s.stream_id) < 1) continue;
                const id = String(s.stream_id);
                const title = clean(s.episode.title || s.title, 160);
                if (!title) continue;
                seen.add(id);
                const prior = await db.prepare("SELECT actor_subject FROM pulse_items WHERE source_service = 'live' AND source_type = 'stream' AND source_id = ?").get(id);
                const r = await store.upsertItem(db, { source_service: 'live', source_type: 'episode', source_id: id,
                    title: `Rundown: ${title}`, url: `${liveApi}/rundown/e/${id}`,
                    actor_subject: prior && prior.actor_subject || null, origin: prior && prior.actor_subject ? 'user' : 'system',
                    occurred_at: sqlFrom(s.episode.aired_at || s.started_at, sqlTime(now())),
                    text: clean(s.episode.logline, 280), picture_url: https(s.thumbnail_url) });
                if (r.created) created++;
            }
            before = typeof out.next === 'string' && out.next ? out.next : null;
            if (!before) break;
        }
        if (before) throw new Error('Rundown pagination exceeded 50 pages; retaining prior episodes');
        const stale = await db.prepare("SELECT source_id FROM pulse_items WHERE source_service = 'live' AND source_type = 'episode'").all();
        for (const row of stale) if (!seen.has(row.source_id)) await store.removeItem(db, 'live', 'episode', row.source_id);
        return created;
    }

    const SOURCES = [
        { name: 'today-events', every: 10 * MINUTE, run: todayEvents },
        { name: 'network-members', every: 60 * MINUTE, run: networkMembers },
        { name: 'quest-badges', every: 15 * MINUTE, run: questBadges },
        { name: 'meme-entries', every: 10 * MINUTE, run: memeEntries },
        { name: 'rundown-episodes', every: 10 * MINUTE, run: rundownEpisodes },
    ];

    async function remember(name, { nextRun, lastRun, error = null }) {
        await db.prepare(`INSERT INTO pulse_source_runs (name, next_run_at, last_run_at, last_error)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET next_run_at = excluded.next_run_at, last_run_at = excluded.last_run_at,
                    last_error = excluded.last_error`)
            .run(name, nextRun, lastRun, error);
    }

    /** Run every source that is due now (or all of them with { force: true }). → [{ name, items } | { name, error }] */
    async function runOnce({ force = false } = {}) {
        if (running) return running;
        running = (async () => {
            const at = now();
            const states = new Map((await db.prepare('SELECT * FROM pulse_source_runs').all()).map((s) => [s.name, s]));
            const out = [];
            for (const source of SOURCES) {
                const state = states.get(source.name);
                if (!force && state && state.next_run_at && state.next_run_at > sqlTime(at)) continue;
                try {
                    const items = await source.run();
                    await remember(source.name, { nextRun: sqlTime(at + source.every), lastRun: sqlTime(at) });
                    out.push({ name: source.name, items });
                } catch (err) {
                    log.warn?.(`[Pulse sources] ${source.name}:`, err.message);
                    await remember(source.name, { nextRun: sqlTime(at + source.every), lastRun: sqlTime(at), error: String(err.message).slice(0, 300) });
                    out.push({ name: source.name, error: err.message });
                }
            }
            return out;
        })().finally(() => { running = null; });
        return await running;
    }

    /** Start the minute check. Only server/index.js calls this (tests run runOnce themselves). */
    function start() {
        if (timer) return;
        const tick = () => { runOnce().catch((err) => log.warn?.('[Pulse sources]:', err.message)); };
        timer = setInterval(tick, MINUTE);
        if (timer.unref) timer.unref();
        const first = setTimeout(tick, 5_000);
        if (first.unref) first.unref();
        timer.first = first;
    }
    function stop() {
        if (timer) clearInterval(timer);
        if (timer && timer.first) clearTimeout(timer.first);
        timer = null;
    }
    async function status() {
        const rows = await db.prepare('SELECT * FROM pulse_source_runs ORDER BY name').all();
        return { sources: SOURCES.map((s) => s.name), runs: rows };
    }

    return { runOnce, start, stop, status, SOURCES: SOURCES.map((s) => s.name) };
}

module.exports = { createPulseSources };
