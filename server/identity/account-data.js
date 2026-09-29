'use strict';
/**
 * Account export and deletion → Community (roadmap WS-B task 7, ADR-033; Contracts 0.71.0). Both arrive at the pulse
 * consumer (POST /internal/events) and are applied once per export or deletion (account_data_events); the delivery is
 * answered after Network took the part or the confirmation, so a failure is redelivered without erasing twice.
 *
 *   network.account.export_requested  Community's part (POST /internal/account-exports/:id/parts with a service token):
 *                                     pastes (with their content), paste comments, comments, threads, posts,
 *                                     attachments, likes, votes and reactions, game progress, blocks and activity.
 *   network.account.deleted           what the subject (and the accounts merged into it) wrote goes. An item with
 *                                     someone else's reply anywhere beneath it stays as an authorless tombstone
 *                                     ("[deleted]"), so the replies keep their place:
 *                                     - a paste others commented on;
 *                                     - a comment or paste comment others answered;
 *                                     - a thread others posted in, and its opening post.
 *                                     Likes, votes and reactions go and cached counts are recomputed. Game progress,
 *                                     blocks both ways, activity items and the cached profile go. Spaces the person
 *                                     created stay without them. Community then confirms with counts.
 */
const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const EXPORT_RE = /^exp_[0-9A-HJKMNP-TV-Z]{26}$/;
const DELETION_RE = /^del_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOPICS = ['network.account.export_requested', 'network.account.deleted'];
const TOMBSTONE = '[deleted]';
const ROW_LIMIT = 5000;

const hasTable = async (db, t) => !!await db.prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?').get(t);
const hasColumn = async (db, table, col) => !!await db.prepare('SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?').get(table, col);
const inList = (xs) => `(${xs.map(() => '?').join(',')})`;


// ── Export ─────────────────────────────────────────────────────

const EXPORTS = [
    ['pastes.json', 'pastes', 'owner_subject'], ['paste_comments.json', 'paste_comments', 'author_subject'], ['comments.json', 'comments', 'author_subject'],
    ['threads.json', 'threads', 'author_subject'], ['posts.json', 'posts', 'author_subject'], ['attachments.json', 'attachments', 'owner_subject'],
    ['paste_likes.json', 'paste_likes', 'subject_id'], ['comment_votes.json', 'comment_votes', 'subject_id'], ['thread_votes.json', 'thread_votes', 'subject_id'],
    ['post_reactions.json', 'post_reactions', 'subject_id'], ['game_progress.json', 'game_progress', 'subject_id'], ['blocks.json', 'network_blocks', 'blocker_subject'],
    ['activity.json', 'pulse_items', 'actor_subject'],
];

async function exportPart(db, subject) {
    const files = [];
    const truncated = [];
    for (const [name, table, col] of EXPORTS) {
        if (!await hasColumn(db, table, col)) continue;
        // Newest first: by id where the table has one, else by its timestamp.
        const order = await hasColumn(db, table, 'id') ? 'id' : await hasColumn(db, table, 'created_at') ? 'created_at' : 'updated_at';
        const rows = await db.prepare(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY ${order} DESC LIMIT ${ROW_LIMIT + 1}`).all(subject);
        if (!rows.length) continue;
        if (rows.length > ROW_LIMIT) truncated.push(name);
        files.push({ name, content: rows.slice(0, ROW_LIMIT) });
    }
    return { files, truncated, note: 'Paste screenshots and attachments are downloaded from their URLs.' };
}

// ── Deletion ───────────────────────────────────────────────────

/** Ids of the rows in `table` authored by the subjects, split into those to delete and those with others' replies. */
async function splitByReplies(db, table, subjects) {
    const mine = (await db.prepare(`SELECT id FROM ${table} WHERE author_subject IN ${inList(subjects)}`).all(...subjects)).map((r) => r.id);
    const keep = [];
    const drop = [];
    for (const id of mine) {
        const other = await db.prepare(`WITH RECURSIVE d(id) AS (SELECT id FROM ${table} WHERE parent_id = ? UNION ALL SELECT c.id FROM ${table} c JOIN d ON c.parent_id = d.id)
                                  SELECT 1 FROM ${table} WHERE id IN (SELECT id FROM d) AND (author_subject IS NULL OR author_subject NOT IN ${inList(subjects)}) LIMIT 1`).get(id, ...subjects);
        (other ? keep : drop).push(id);
    }
    return { keep, drop };
}

async function erase(db, subjects, { now = new Date().toISOString() } = {}) {
    const erased = {};
    const retained = {};
    const add = (o, k, n) => { if (n) o[k] = (o[k] || 0) + n; };
    const S = inList(subjects);
    await db.tx(async () => {
        // Likes, votes and reactions first, so the counts recomputed below see only what stays.
        const recount = [];
        for (const [table, item] of [['paste_likes', 'paste_id'], ['comment_votes', 'comment_id'], ['thread_votes', 'thread_id'], ['post_reactions', 'post_id']]) {
            if (!await hasTable(db, table)) continue;
            const items = (await db.prepare(`SELECT DISTINCT ${item} AS i FROM ${table} WHERE subject_id IN ${S}`).all(...subjects)).map((r) => r.i);
            add(erased, table, (await db.prepare(`DELETE FROM ${table} WHERE subject_id IN ${S}`).run(...subjects)).changes);
            recount.push([table, items]);
        }
        // Pastes: gone, unless someone else commented.
        if (await hasTable(db, 'pastes')) {
            for (const p of await db.prepare(`SELECT id FROM pastes WHERE owner_subject IN ${S}`).all(...subjects)) {
                const others = await db.prepare(`SELECT 1 FROM paste_comments WHERE paste_id = ? AND (author_subject IS NULL OR author_subject NOT IN ${S}) LIMIT 1`).get(p.id, ...subjects);
                if (others) {
                    await db.prepare(`UPDATE pastes SET owner_subject = NULL, title = ?, content = '', screenshot_url = NULL, media_ref = NULL, stream_ref = NULL, metadata = NULL,
                                ai_summary = NULL, ai_tags = NULL, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?`).run(TOMBSTONE, now, now, p.id);
                    add(retained, 'tombstones', 1);
                } else {
                    await db.prepare('DELETE FROM pastes WHERE id = ?').run(p.id);
                    add(erased, 'pastes', 1);
                }
            }
        }
        // Comments on pastes and on threads (VODs, clips, pages): gone, unless someone else answered beneath.
        for (const [table, tomb] of [['paste_comments', 'author_subject = NULL, anon_name = NULL, message = ?, is_deleted = 1, updated_at = ?'],
            ['comments', 'author_subject = NULL, anon_name = NULL, message = ?, deleted_at = COALESCE(deleted_at, ?)']]) {
            if (!await hasTable(db, table)) continue;
            const { keep, drop } = await splitByReplies(db, table, subjects);
            for (const id of keep) await db.prepare(`UPDATE ${table} SET ${tomb} WHERE id = ?`).run(TOMBSTONE, now, id);
            for (const id of drop) await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
            add(erased, table, drop.length);
            add(retained, 'tombstones', keep.length);
            if (table === 'comments') await db.prepare('UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments c WHERE c.parent_id = comments.id) WHERE reply_count != (SELECT COUNT(*) FROM comments c WHERE c.parent_id = comments.id)').run();
        }
        // Threads: gone with their posts, unless someone else posted; then the thread and its opening post are tombstones.
        if (await hasTable(db, 'threads')) {
            for (const t of await db.prepare(`SELECT id FROM threads WHERE author_subject IN ${S}`).all(...subjects)) {
                const others = await db.prepare(`SELECT 1 FROM posts WHERE thread_id = ? AND (author_subject IS NULL OR author_subject NOT IN ${S}) LIMIT 1`).get(t.id, ...subjects);
                if (others) { await db.prepare('UPDATE threads SET author_subject = NULL, title = ? WHERE id = ?').run(TOMBSTONE, t.id); add(retained, 'tombstones', 1); }
                else { await db.prepare('DELETE FROM threads WHERE id = ?').run(t.id); add(erased, 'threads', 1); }
            }
        }
        if (await hasTable(db, 'posts')) {
            for (const p of await db.prepare(`SELECT id, thread_id, is_opening FROM posts WHERE author_subject IN ${S}`).all(...subjects)) {
                const others = p.is_opening && await db.prepare(`SELECT 1 FROM posts WHERE thread_id = ? AND id != ? AND (author_subject IS NULL OR author_subject NOT IN ${S}) LIMIT 1`).get(p.thread_id, p.id, ...subjects);
                if (others) { await db.prepare('UPDATE posts SET author_subject = NULL, relay_author = NULL, body_markdown = ?, deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ?').run(TOMBSTONE, now, now, p.id); add(retained, 'tombstones', 1); }
                else { await db.prepare('DELETE FROM posts WHERE id = ?').run(p.id); add(erased, 'posts', 1); }
            }
            if (await hasColumn(db, 'threads', 'reply_count')) await db.prepare("UPDATE threads SET reply_count = (SELECT COUNT(*) FROM posts p WHERE p.thread_id = threads.id AND p.is_opening = 0)").run();
        }
        if (await hasTable(db, 'attachments')) add(erased, 'attachments', (await db.prepare(`DELETE FROM attachments WHERE owner_subject IN ${S}`).run(...subjects)).changes);
        for (const [table, where, key] of [['game_progress', `subject_id IN ${S}`, 'game_progress'], ['pulse_items', `actor_subject IN ${S}`, 'activity'],
            ['subject_projection', `subject_id IN ${S}`, 'profile'], ['profile_module_pushes', `subject_id IN ${S}`, 'profile'],
            ['network_blocks', `blocker_subject IN ${S} OR blocked_subject IN ${S}`, 'blocks']]) {
            if (!await hasTable(db, table)) continue;
            const params = where.includes(' OR ') ? [...subjects, ...subjects] : subjects;
            add(erased, key, (await db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params)).changes);
        }
        for (const table of ['spaces', 'comment_threads']) if (await hasColumn(db, table, 'created_by')) await db.prepare(`UPDATE ${table} SET created_by = NULL WHERE created_by IN ${S}`).run(...subjects);
        // The cached counts and scores follow the rows that stay.
        for (const [table, items] of recount) {
            for (const i of items) {
                if (table === 'paste_likes') await db.prepare('UPDATE pastes SET likes = (SELECT COUNT(*) FROM paste_likes WHERE paste_id = ?) WHERE id = ?').run(i, i);
                else if (table === 'comment_votes') {
                    const a = await db.prepare('SELECT COALESCE(SUM(value), 0)::bigint AS s, COUNT(*) FILTER (WHERE value = 1) AS u, COUNT(*) FILTER (WHERE value = -1) AS d FROM comment_votes WHERE comment_id = ?').get(i);
                    await db.prepare('UPDATE comments SET score = ?, upvotes = ?, downvotes = ? WHERE id = ?').run(a.s, a.u, a.d, i);
                } else if (table === 'thread_votes') await db.prepare('UPDATE threads SET score = (SELECT COALESCE(SUM(value), 0)::bigint FROM thread_votes WHERE thread_id = ?) WHERE id = ?').run(i, i);
            }
        }
    });
    return { erased, retained };
}

// ── Events ─────────────────────────────────────────────────────

function createSender({ config, fetchImpl = globalThis.fetch } = {}) {
    const { serviceAuth } = require('openvibe-contracts');
    const tokens = serviceAuth.createTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, audience: 'openvibe.network', fetchImpl });
    return async function send(path, body, retried = false) {
        const res = await fetchImpl(`${config.networkInternalUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(await tokens.authHeaders()) }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
        if (res.status === 401 && !retried) { tokens.invalidate(); return await send(path, body, true); }
        return res;
    };
}

/** One envelope → 'exported' | 'erased' | 'confirmed' | 'closed' | 'unchanged' | 'ignored:<why>'; throws to be redelivered. */
async function apply(db, ev, { send, log = console } = {}) {
    if (!ev || !TOPICS.includes(ev.event_type)) return 'ignored:type';
    if (ev.source !== 'network') return 'ignored:source';
    const p = ev.payload && typeof ev.payload === 'object' ? ev.payload : {};
    if (ev.event_type === 'network.account.export_requested') {
        if (!EXPORT_RE.test(String(p.export_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
        const seen = await db.prepare('SELECT sent_at FROM account_data_events WHERE id = ?').get(p.export_id);
        if (seen && seen.sent_at) return 'unchanged';
        const part = await exportPart(db, p.subject);
        const res = await send(`/internal/account-exports/${p.export_id}/parts`, { subject: p.subject, ...part });
        const outcome = res.ok ? 'exported' : (res.status === 409 || res.status === 404 ? 'closed' : null);
        if (!outcome) throw new Error(`export part refused: ${res.status}`);
        await db.prepare(`INSERT INTO account_data_events (id, kind, subject, outcome, sent_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, subject = excluded.subject, outcome = excluded.outcome, sent_at = excluded.sent_at, applied_at = ov_now_iso()`)
            .run(p.export_id, 'export', p.subject, JSON.stringify({ result: outcome, files: part.files.length }), new Date().toISOString());
        return outcome;
    }
    if (!DELETION_RE.test(String(p.deletion_id || '')) || !SUBJECT_RE.test(String(p.subject || ''))) return 'ignored:payload';
    let rec = await db.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
    let result = 'confirmed';
    if (!rec) {
        const subjects = [p.subject, ...(Array.isArray(p.aliases) ? p.aliases.filter((s) => SUBJECT_RE.test(String(s))) : [])];
        const counts = await erase(db, subjects);
        await db.prepare('INSERT INTO account_data_events (id, kind, subject, outcome) VALUES (?, ?, ?, ?)').run(p.deletion_id, 'deletion', p.subject, JSON.stringify(counts));
        log.log(`[AccountData] deletion ${p.deletion_id}: ${JSON.stringify(counts)}`);
        rec = await db.prepare('SELECT * FROM account_data_events WHERE id = ?').get(p.deletion_id);
        result = 'erased';
    }
    if (rec.sent_at) return 'unchanged';
    const o = JSON.parse(rec.outcome || '{}');
    const res = await send(`/internal/account-deletions/${p.deletion_id}/confirmations`, { subject: p.subject, completed_at: rec.applied_at, erased: o.erased || {}, retained: o.retained || {} });
    if (!res.ok && res.status !== 404) throw new Error(`confirmation refused: ${res.status}`);
    await db.prepare('UPDATE account_data_events SET sent_at = ? WHERE id = ?').run(new Date().toISOString(), p.deletion_id);
    return result;
}

module.exports = { apply, exportPart, erase, createSender, TOPICS };
