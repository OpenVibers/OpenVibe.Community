'use strict';

/**
 * Discord relay, outbound only (DISCORD_RELAY_ENABLED; off by default).
 *
 * When a thread is created in a public space that has an enabled relay_mappings row, one
 * relay_deliveries row is created per (thread, mapping) — its dedupe key — and a worker posts a
 * message with source attribution and a link to the mapping's Discord webhook.
 *
 *   - Secrets never live in the database: a mapping stores webhook_url_ref, the NAME of an
 *     environment variable (e.g. DISCORD_WEBHOOK_FEEDBACK); the URL is read from process.env at
 *     send time. Only allow-listed names: DISCORD_RELAY_WEBHOOK_VARS (exact names) when set, else
 *     DISCORD_WEBHOOK_*. Staff can therefore never point the relay at the URL in some other
 *     variable (an internal service's base URL), nor learn which other variables are set; a
 *     mapping outside the list is refused when made and never sent.
 *   - Loop prevention: a thread whose origin is 'discord' (a future inbound relay) is never
 *     relayed out, checked both when queueing and when sending.
 *   - Retries: network errors, timeouts, 5xx, 429 and a missing webhook variable are retried with
 *     exponential backoff (baseMs · 2^(attempt−1), capped at an hour; a 429's retry_after is
 *     honoured) up to maxAttempts, then the delivery is 'failed'. Other 4xx answers fail at once.
 *   - Mentions are disabled (allowed_mentions.parse = []), so a title can never ping anyone.
 * Failures are visible to staff at GET /api/v1/relay/deliveries.
 */
const pasteStore = require('../pastes/store');
const forumStore = require('../forum/store');
const { markdownToText } = require('../render/markdown');
const { sqlTime, isoTime } = require('../http/v1');
const { AI_DISPLAY_NAME } = require('../identity/authors');

const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const WEBHOOK_VAR = /^DISCORD_WEBHOOK_[A-Z0-9_]+$/;
const MAX_BACKOFF_MS = 60 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

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

    function deliveryKey(threadId, mappingId) { return `thread:${threadId}:mapping:${mappingId}`; }

    /** Queue a new thread for every enabled out-mapping of its space. → number of deliveries queued */
    function enqueueThread(thread, space) {
        if (!enabled || !thread || !space) return 0;
        if (thread.origin === 'discord') return 0;       // loop prevention
        if (space.visibility !== 'public') return 0;     // members/staff spaces never leave the site
        const mappings = db.prepare("SELECT * FROM relay_mappings WHERE space_id = ? AND direction = 'out' AND enabled = 1").all(space.id);
        let queued = 0;
        const insert = db.prepare(`INSERT INTO relay_deliveries (thread_id, mapping_id, dedupe_key, next_attempt_at) VALUES (?, ?, ?, ?)
                                   ON CONFLICT(dedupe_key) DO NOTHING`);
        for (const m of mappings) queued += insert.run(thread.id, m.id, deliveryKey(thread.id, m.id), sqlTime(now())).changes;
        if (queued) kick();
        return queued;
    }

    function kick() { setImmediate(() => { drain().catch((err) => console.warn('[Relay] drain failed:', err.message)); }); }

    function message(thread, space) {
        const opening = db.prepare('SELECT body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1').get(thread.id);
        let who = 'someone';
        if (thread.origin === 'ai') who = AI_DISPLAY_NAME;
        else if (thread.author_subject) {
            const p = pasteStore.getProjections(db, [thread.author_subject]).get(thread.author_subject);
            if (p) who = p.display_name || p.username || who;
        }
        const url = `${base}/s/${space.slug}/t/${thread.slug}`;
        return {
            username: 'OpenVibe.Community',
            content: `New thread in **s/${escapeDiscord(space.slug)}** by ${escapeDiscord(who)}: <${url}>`,
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

    function backoff(attempts, retryAfterSec) {
        const exp = Math.min(baseMs * Math.pow(2, Math.max(attempts - 1, 0)), MAX_BACKOFF_MS);
        return Math.max(exp, retryAfterSec ? retryAfterSec * 1000 : 0);
    }

    function record(d, { ok, status = null, error = null, retry = false, retryAfter = 0 }) {
        const attempts = d.attempts + 1;
        if (ok) {
            db.prepare("UPDATE relay_deliveries SET status = 'delivered', attempts = ?, last_status = ?, last_error = NULL, delivered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .run(attempts, status, d.id);
            return 'delivered';
        }
        const giveUp = !retry || attempts >= maxAttempts;
        db.prepare('UPDATE relay_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(giveUp ? 'failed' : 'pending', attempts, status, String(error || '').slice(0, 500), sqlTime(now() + (giveUp ? 0 : backoff(attempts, retryAfter))), d.id);
        return giveUp ? 'failed' : 'retry';
    }

    async function send(d) {
        const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(d.thread_id);
        const space = thread ? forumStore.getSpaceById(db, thread.space_id) : null;
        if (!thread || thread.deleted_at || !space) return record(d, { ok: false, error: 'thread is gone' });
        if (thread.origin === 'discord') return record(d, { ok: false, error: 'loop prevention: thread came from Discord' });
        if (!refAllowed(d.webhook_url_ref)) return record(d, { ok: false, error: 'webhook_url_ref is not an allowed webhook variable' });
        const url = env[d.webhook_url_ref];
        if (!url) return record(d, { ok: false, retry: true, error: `webhook URL variable ${d.webhook_url_ref} is not set` });
        if (!/^https?:\/\//i.test(url)) return record(d, { ok: false, error: `${d.webhook_url_ref} is not an http(s) URL` });
        let res;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'User-Agent': 'OpenVibe.Community relay' },
                body: JSON.stringify(message(thread, space)),
                signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
            });
        } catch (err) {
            return record(d, { ok: false, retry: true, error: err.name === 'TimeoutError' ? 'timed out' : err.message });
        }
        if (res.ok) return record(d, { ok: true, status: res.status });
        let detail = '';
        let retryAfter = Number(res.headers.get('retry-after')) || 0;
        try { const j = await res.json(); detail = j && (j.message || j.error) ? String(j.message || j.error) : ''; if (j && j.retry_after) retryAfter = Math.max(retryAfter, Number(j.retry_after) || 0); } catch { /* not JSON */ }
        const retry = res.status === 429 || res.status === 408 || res.status >= 500;
        return record(d, { ok: false, retry, retryAfter, status: res.status, error: `Discord answered ${res.status}${detail ? `: ${detail}` : ''}` });
    }

    /** Send every due delivery once. One drain at a time. → { delivered, retry, failed } */
    function drain() {
        if (draining) return draining;
        draining = (async () => {
            const summary = { delivered: 0, retry: 0, failed: 0 };
            if (!enabled) return summary;
            const due = db.prepare(`SELECT d.*, m.webhook_url_ref FROM relay_deliveries d JOIN relay_mappings m ON m.id = d.mapping_id
                                    WHERE d.status = 'pending' AND m.enabled = 1 AND d.next_attempt_at <= ? ORDER BY d.id ASC LIMIT 50`).all(sqlTime(now()));
            for (const d of due) summary[await send(d)]++;
            return summary;
        })().finally(() => { draining = null; });
        return draining;
    }

    function start() {
        if (!enabled || timer) return;
        timer = setInterval(() => { drain().catch((err) => console.warn('[Relay] drain failed:', err.message)); }, pollMs);
        if (timer.unref) timer.unref();
        kick();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    // ── admin (staff) ────────────────────────────────────────
    function shapeMapping(m) {
        return { id: m.id, space: m.space_slug, direction: m.direction, webhook_url_ref: m.webhook_url_ref, webhook_configured: refAllowed(m.webhook_url_ref) && !!env[m.webhook_url_ref], enabled: !!m.enabled, created_at: isoTime(m.created_at) };
    }
    function listMappings() {
        return db.prepare('SELECT m.*, s.slug AS space_slug FROM relay_mappings m JOIN spaces s ON s.id = m.space_id ORDER BY m.id').all().map(shapeMapping);
    }
    function addMapping({ space_id, webhook_url_ref, enabled: on = true }) {
        if (!refAllowed(webhook_url_ref)) throw new Error(`${webhook_url_ref} is not an allowed webhook variable`);
        db.prepare(`INSERT INTO relay_mappings (space_id, direction, webhook_url_ref, enabled) VALUES (?, 'out', ?, ?)
                    ON CONFLICT(space_id, direction, webhook_url_ref) DO UPDATE SET enabled = excluded.enabled`).run(space_id, webhook_url_ref, on ? 1 : 0);
        return shapeMapping(db.prepare("SELECT m.*, s.slug AS space_slug FROM relay_mappings m JOIN spaces s ON s.id = m.space_id WHERE m.space_id = ? AND m.direction = 'out' AND m.webhook_url_ref = ?").get(space_id, webhook_url_ref));
    }
    function setMappingEnabled(id, on) {
        if (!db.prepare('UPDATE relay_mappings SET enabled = ? WHERE id = ?').run(on ? 1 : 0, id).changes) return null;
        return shapeMapping(db.prepare('SELECT m.*, s.slug AS space_slug FROM relay_mappings m JOIN spaces s ON s.id = m.space_id WHERE m.id = ?').get(id));
    }
    function listDeliveries({ status = null, limit = 50 } = {}) {
        return db.prepare(`SELECT d.*, m.webhook_url_ref, t.title AS thread_title, t.slug AS thread_slug, s.slug AS space_slug
                           FROM relay_deliveries d JOIN relay_mappings m ON m.id = d.mapping_id JOIN threads t ON t.id = d.thread_id JOIN spaces s ON s.id = t.space_id
                           WHERE (? IS NULL OR d.status = ?) ORDER BY d.id DESC LIMIT ?`).all(status, status, limit)
            .map((d) => ({
                id: d.id, dedupe_key: d.dedupe_key, status: d.status, attempts: d.attempts, last_status: d.last_status, last_error: d.last_error,
                next_attempt_at: d.status === 'pending' ? isoTime(d.next_attempt_at) : null, delivered_at: isoTime(d.delivered_at), created_at: isoTime(d.created_at),
                mapping: { id: d.mapping_id, webhook_url_ref: d.webhook_url_ref },
                thread: { id: d.thread_id, title: d.thread_title, url: `/s/${d.space_slug}/t/${d.thread_slug}` },
            }));
    }
    /** Put a failed (or pending) delivery back in the queue now, with a fresh attempt budget. */
    function retry(id) {
        const n = db.prepare("UPDATE relay_deliveries SET status = 'pending', attempts = 0, next_attempt_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status <> 'delivered'").run(sqlTime(now()), id).changes;
        if (n) kick();
        return n;
    }

    return { enabled, enqueueThread, drain, start, stop, listMappings, addMapping, setMappingEnabled, listDeliveries, retry, ENV_NAME, refAllowed, message };
}

module.exports = { createDiscordRelay, escapeDiscord, ENV_NAME, WEBHOOK_VAR };
