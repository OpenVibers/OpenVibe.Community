'use strict';

/**
 * Replies from Discord (roadmap WS-J task 6, inbound; DISCORD_RELAY_INBOUND=on with DISCORD_BOT_TOKEN).
 * The gateway (relay/discord-gateway.js) hands message events here.
 *
 * What becomes a post: only messages in a mapped channel (a mapping with inbound on: its
 * discord_channel_id or discord_thread_id, or a Discord thread started from one of its messages), and
 * only replies to something in the external message map:
 *   - a Discord reply (message_reference) to a mapped message in the same channel, or
 *   - any message in a Discord thread started from a mapped message (that thread's id is the message's).
 * Everything else in the channel is ignored. The post goes into the mapped message's local thread with
 * origin 'discord', no author subject (never attributed to anyone on the site; the Discord display name
 * is kept in posts.relay_author and shown with a "Discord" badge), and the map gets its direction 'in'
 * row. Edits on Discord edit the post (a new revision, edited_by 'discord'); deletes on Discord delete
 * it. A delete of a message the relay sent only marks it gone there (the thread stays).
 *
 * Loop prevention: webhook messages (the relay's own among them), bots, the bot itself and system
 * messages are never taken in; a message already in the map is never taken twice (and the map's unique
 * key refuses it anyway); posts with origin 'discord' are never relayed out (relay/discord.js).
 * Limits: perMinute messages per Discord author per mapping and 10× that per mapping (a rolling
 * minute), maxChars per message (longer text is cut). Mentions, roles, channels, custom emoji and
 * timestamps become plain text and @everyone/@here are defused; the rest is Markdown, which the
 * forum's safe renderer shows (render/markdown.js: no raw HTML, safe links only). Attachments are
 * noted, never fetched. The thread must still be public, open (not locked) and not members-only.
 * What could not be applied goes to relay_inbound_failures: ids and the reason, never the text.
 */
const forumStore = require('../forum/store');
const { SNOWFLAKE } = require('./discord');

const KEEP_FAILURES = 1000;
const MESSAGE_TYPES = new Set([0, 19]);   // DEFAULT, REPLY

/** A Discord display name as plain text: no control or format characters, one line, at most 32. */
function cleanName(s) {
    const t = String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F-\u009F\u200b-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 32);
}

/** Discord message text → forum Markdown (see the header). '' when there is nothing to show. */
function toMarkdown(d, maxChars = 4000) {
    const names = new Map((Array.isArray(d.mentions) ? d.mentions : []).map((u) => [String(u && u.id), cleanName(u && (u.global_name || u.username))]));
    let text = (typeof d.content === 'string' ? d.content : '')
        .replace(/<@!?(\d{15,21})>/g, (_, id) => `@${names.get(id) || 'someone'}`)
        .replace(/<@&\d{15,21}>/g, '@role')
        .replace(/<#\d{15,21}>/g, '#channel')
        .replace(/<\/([\w-]{1,32}(?: [\w-]{1,32}){0,2}):\d{15,21}>/g, '/$1')
        .replace(/<a?:(\w{1,32}):\d{15,21}>/g, ':$1:')
        .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_, sec) => {
            const t = new Date(Number(sec) * 1000);
            return Number.isNaN(t.getTime()) ? '' : `${t.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        })
        .replace(/@(everyone|here)/g, '@\u200b$1')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();
    if (text.length > maxChars) text = `${text.slice(0, Math.max(maxChars - 1, 0)).trimEnd()}…`;
    const files = Array.isArray(d.attachments) ? d.attachments.length : 0;
    if (files) text += `${text ? '\n\n' : ''}_(${files} attachment${files === 1 ? '' : 's'} on Discord)_`;
    return text;
}

function createDiscordInbound({ db, perMinute = 6, maxChars = 4000, now = () => Date.now() } = {}) {
    const windows = new Map();   // key → timestamps in the last minute
    const counts = { applied: 0, ignored: 0, failed: 0 };

    function allow(key, limit) {
        const t = now();
        const list = (windows.get(key) || []).filter((x) => t - x < 60_000);
        if (list.length >= limit) { windows.set(key, list); return false; }
        list.push(t);
        windows.set(key, list);
        if (windows.size > 5000) for (const [k, l] of windows) if (!l.length || t - l[l.length - 1] >= 60_000) windows.delete(k);
        return true;
    }

    const mapByMessage = (id) => db.prepare("SELECT * FROM relay_message_map WHERE platform = 'discord' AND external_message_id = ?").get(String(id)) || null;
    const mappingById = (id) => db.prepare('SELECT * FROM relay_mappings WHERE id = ?').get(id) || null;

    function ignore(reason) { counts.ignored++; return { status: 'ignored', reason }; }
    function failure(event, d, mappingId, error) {
        db.prepare(`INSERT INTO relay_inbound_failures (mapping_id, event, external_channel_id, external_message_id, external_author_id, error)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(mappingId || null, event, d.channel_id ? String(d.channel_id) : null, d.id ? String(d.id) : null, d.author && d.author.id ? String(d.author.id) : null, String(error).slice(0, 300));
        db.prepare('DELETE FROM relay_inbound_failures WHERE id <= (SELECT MAX(id) FROM relay_inbound_failures) - ?').run(KEEP_FAILURES);
        counts.failed++;
        return { status: 'failed', error };
    }
    /** Is the local thread still somewhere a reply from Discord may land? → null or why not */
    function closed(thread) {
        if (!thread || thread.deleted_at) return 'the thread was deleted';
        const space = forumStore.getSpaceById(db, thread.space_id);
        if (!space || space.visibility !== 'public' || space.members_only_owner || thread.members_only_owner) return 'the thread is not public';
        if (thread.locked) return 'the thread is locked';
        return null;
    }

    function create(d, botUserId) {
        if (d.webhook_id) return ignore('a webhook message (the relay\'s own included)');
        const author = d.author || {};
        if (!author.id || author.bot || author.system || (botUserId && String(author.id) === String(botUserId))) return ignore('a bot or system message');
        if (d.type !== undefined && !MESSAGE_TYPES.has(Number(d.type))) return ignore('not a plain message or a reply');
        if (!SNOWFLAKE.test(String(d.id || '')) || !SNOWFLAKE.test(String(d.channel_id || ''))) return ignore('malformed ids');
        if (mapByMessage(d.id)) return ignore('already relayed');
        const channel = String(d.channel_id);
        // A Discord thread started from a mapped message, else a reply to one in the same channel.
        let anchor = mapByMessage(channel);
        // (message_reference type 1 is a forward, not a reply: never taken in.)
        if (!anchor && d.message_reference && d.message_reference.message_id && !Number(d.message_reference.type || 0)) {
            const ref = mapByMessage(String(d.message_reference.message_id));
            if (ref && ref.external_channel_id === channel) anchor = ref;
        }
        if (!anchor) return ignore('not a reply to a relayed message');
        const mapping = mappingById(anchor.mapping_id);
        if (!mapping || !mapping.enabled || !mapping.inbound) return ignore('inbound is off for this mapping');
        const mapped = [mapping.discord_channel_id, mapping.discord_thread_id].filter(Boolean);
        const inMapped = mapped.includes(channel) || (channel === anchor.external_message_id && mapped.includes(anchor.external_channel_id));
        if (!inMapped) return ignore('not a mapped channel');
        const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(anchor.thread_id);
        const why = closed(thread);
        if (why) return failure('MESSAGE_CREATE', d, mapping.id, why);
        if (!allow(`a:${mapping.id}:${author.id}`, perMinute) || !allow(`m:${mapping.id}`, perMinute * 10)) return failure('MESSAGE_CREATE', d, mapping.id, 'rate limited');
        const body = toMarkdown(d, maxChars);
        if (!body) return failure('MESSAGE_CREATE', d, mapping.id, 'the message has no text: is the MESSAGE CONTENT intent on for the bot?');
        const name = cleanName((d.member && d.member.nick) || author.global_name || author.username) || 'Discord';
        try {
            const post = db.transaction(() => {
                const p = forumStore.addPost(db, { thread_id: thread.id, author_subject: null, origin: 'discord', body_markdown: body, relay_author: name });
                db.prepare(`INSERT INTO relay_message_map (platform, mapping_id, direction, local_type, local_id, thread_id, external_channel_id, external_message_id)
                            VALUES ('discord', ?, 'in', 'post', ?, ?, ?, ?)`).run(mapping.id, p.id, thread.id, channel, String(d.id));
                return p;
            })();
            counts.applied++;
            return { status: 'applied', post_id: post.id };
        } catch (err) {
            if (/UNIQUE/.test(err.message)) return ignore('already relayed');
            return failure('MESSAGE_CREATE', d, mapping.id, `could not save the post: ${err.message}`);
        }
    }

    function update(d) {
        if (!d.id) return ignore('malformed ids');
        const row = mapByMessage(d.id);
        if (!row) return ignore('not a relayed message');
        if (row.direction !== 'in') return ignore('the relay\'s own message');
        if (typeof d.content !== 'string') return ignore('no text change');
        const mapping = mappingById(row.mapping_id);
        if (!mapping || !mapping.enabled || !mapping.inbound) return ignore('inbound is off for this mapping');
        const post = forumStore.getPost(db, row.local_id);
        if (!post || post.deleted_at) return failure('MESSAGE_UPDATE', d, mapping.id, 'the post was deleted');
        const why = closed(db.prepare('SELECT * FROM threads WHERE id = ?').get(post.thread_id));
        if (why) return failure('MESSAGE_UPDATE', d, mapping.id, why);
        const body = toMarkdown(d, maxChars);
        if (!body) return failure('MESSAGE_UPDATE', d, mapping.id, 'the edit has no text');
        forumStore.editPost(db, post.id, body, 'discord');
        db.prepare('UPDATE relay_message_map SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.id);
        counts.applied++;
        return { status: 'applied', post_id: post.id };
    }

    /** A delete on Discord. Applied whatever the mapping's switches: taking something down never waits. */
    function remove(id) {
        const row = mapByMessage(id);
        if (!row) return ignore('not a relayed message');
        db.transaction(() => {
            db.prepare('UPDATE relay_message_map SET external_deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND external_deleted_at IS NULL').run(row.id);
            if (row.direction === 'in') forumStore.softDeletePost(db, row.local_id);
        })();
        counts.applied++;
        return { status: 'applied', post_id: row.direction === 'in' ? row.local_id : null, note: row.direction === 'out' ? 'the relay\'s message was deleted on Discord; the thread stays' : undefined };
    }

    /** One gateway dispatch (type, data, { botUserId }) → result (an array for a bulk delete). */
    function handle(type, d, { botUserId = null } = {}) {
        if (!d || typeof d !== 'object') return ignore('no data');
        if (type === 'MESSAGE_CREATE') return create(d, botUserId);
        if (type === 'MESSAGE_UPDATE') return update(d);
        if (type === 'MESSAGE_DELETE') return remove(String(d.id || ''));
        if (type === 'MESSAGE_DELETE_BULK') return (Array.isArray(d.ids) ? d.ids : []).map((id) => remove(String(id)));
        return ignore('not a message event');
    }

    // ── staff ────────────────────────────────────────────────
    function listFailures({ all = false, limit = 50 } = {}) {
        return db.prepare(`SELECT f.*, s.slug AS space_slug FROM relay_inbound_failures f LEFT JOIN relay_mappings m ON m.id = f.mapping_id LEFT JOIN spaces s ON s.id = m.space_id
                           WHERE (? = 1 OR f.dismissed_at IS NULL) ORDER BY f.id DESC LIMIT ?`).all(all ? 1 : 0, limit)
            .map((f) => ({
                id: f.id, event: f.event, error: f.error, mapping: f.mapping_id ? { id: f.mapping_id, space: f.space_slug || null } : null,
                discord: { channel_id: f.external_channel_id, message_id: f.external_message_id, author_id: f.external_author_id },
                dismissed: !!f.dismissed_at, created_at: f.created_at ? new Date(`${String(f.created_at).replace(' ', 'T')}Z`).toISOString() : null,
            }));
    }
    function dismiss(id) {
        return db.prepare('UPDATE relay_inbound_failures SET dismissed_at = CURRENT_TIMESTAMP WHERE id = ? AND dismissed_at IS NULL').run(id).changes;
    }

    return { handle, listFailures, dismiss, stats: () => ({ ...counts }) };
}

module.exports = { createDiscordInbound, toMarkdown, cleanName };
