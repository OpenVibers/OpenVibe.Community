'use strict';

/**
 * Comment store — pure SQL over comment_threads / comments (server/db.js). No HTTP, identity or
 * policy: service.js decides who may do what. Votes live in server/votes.js.
 *
 * A thread belongs to one foreign entity (EntityRef service/type/id) and is created on first
 * resolve. Comments nest one level: a reply's parent is always a top-level comment. Deletes are
 * soft (message scrubbed); a deleted top-level comment that still has replies stays as a
 * tombstone so the replies keep their context.
 */
const { newThreadAccessId } = require('../db');
const forumLinks = require('./forum-links');

async function getThread(db, id) {
    return await db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(id) || null;
}

/** A thread by the unguessable handle browsers use (server/db.js: access_id). */
async function getThreadByAccessId(db, accessId) {
    return await db.prepare('SELECT * FROM comment_threads WHERE access_id = ?').get(String(accessId)) || null;
}

async function getThreadByRef(db, ref) {
    return await db.prepare('SELECT * FROM comment_threads WHERE ref_service = ? AND ref_type = ? AND ref_id = ?')
        .get(ref.service, ref.type, String(ref.id)) || null;
}

/**
 * Get-or-create the thread of an entity. Idempotent and race-safe: the UNIQUE(service, type, id)
 * constraint decides, INSERT … ON CONFLICT DO NOTHING never fails, and the row is read back.
 * A label (from a service) refreshes the cached one. → { thread, created }
 */
async function resolveThread(db, ref, { label = null, createdBy = null } = {}) {
    return await db.tx(async () => {
        const info = await db.prepare(`INSERT INTO comment_threads (ref_service, ref_type, ref_id, ref_label, created_by, access_id) VALUES (?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(ref_service, ref_type, ref_id) DO NOTHING RETURNING id`)
            .run(ref.service, ref.type, String(ref.id), label, createdBy, newThreadAccessId());
        if (!info.changes && label) {
            await db.prepare('UPDATE comment_threads SET ref_label = ?, updated_at = ov_now() WHERE ref_service = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_label, \'\') <> ?')
                .run(label, ref.service, ref.type, String(ref.id), label);
        }
        return { thread: await getThreadByRef(db, ref), created: info.changes > 0 };
    });
}

async function setThreadVisibility(db, id, visibility) {
    await db.prepare('UPDATE comment_threads SET visibility = ?, updated_at = ov_now() WHERE id = ?').run(visibility, id);
    return await getThread(db, id);
}

async function getComment(db, id) {
    const row = await db.prepare('SELECT * FROM comments WHERE id = ?').get(id) || null;
    if (row) row.attachments = await listAttachments(db, [row.id]).then((m) => m.get(row.id) || []);
    return row;
}

/** References staged by the owning service, grouped by comment id. */
async function listAttachments(db, commentIds) {
    const out = new Map();
    const ids = [...new Set((commentIds || []).map(Number).filter(Number.isSafeInteger))];
    for (const id of ids) out.set(id, []);
    if (!ids.length) return out;
    const rows = await db.prepare(`SELECT * FROM comment_attachments WHERE comment_id IN (${ids.map(() => '?').join(',')}) ORDER BY comment_id, created_at, media_id`).all(...ids);
    for (const row of rows) if (out.has(row.comment_id)) out.get(row.comment_id).push(row);
    return out;
}

async function createAttachment(db, row) {
    await db.prepare(`INSERT INTO comment_attachments (media_id, ref_service, ref_type, ref_id, owner_subject, filename, mime, size_bytes, visibility)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.media_id, row.ref_service, row.ref_type, row.ref_id, row.owner_subject, row.filename, row.mime, row.size_bytes, row.visibility);
    return await db.prepare('SELECT * FROM comment_attachments WHERE media_id = ?').get(row.media_id);
}

async function stagedAttachments(db, ids, subject, ref) {
    if (!ids.length) return [];
    const rows = await db.prepare(`SELECT * FROM comment_attachments WHERE media_id IN (${ids.map(() => '?').join(',')})
        AND comment_id IS NULL AND owner_subject = ? AND ref_service = ? AND ref_type = ? AND ref_id = ?`).all(...ids, subject, ref.service, ref.type, String(ref.id));
    return rows.length === ids.length ? rows : null;
}

/**
 * Is the thread's item known to be public? Only Community's own can be checked: a public paste that is
 * not deleted and does not burn, or a live post in a public space outside members-only. Anything else (a
 * Live VOD or clip may be private; only Live knows) is not, so its comment events stay internal.
 */
async function refIsPublic(db, t) {
    if (!t || t.ref_service !== 'community') return false;
    if (t.ref_type === 'paste') {
        return !!await db.prepare("SELECT 1 FROM pastes WHERE slug = ? AND deleted_at IS NULL AND visibility = 'public' AND burn_after_read = 0").get(String(t.ref_id));
    }
    if (t.ref_type === 'post' && /^\d{1,15}$/.test(String(t.ref_id))) {
        return !!await db.prepare(`SELECT 1 FROM posts p JOIN threads th ON th.id = p.thread_id JOIN spaces s ON s.id = th.space_id
                             WHERE p.id = ? AND p.deleted_at IS NULL AND th.deleted_at IS NULL AND s.visibility = 'public'
                               AND s.members_only_owner IS NULL AND th.members_only_owner IS NULL`).get(Number(t.ref_id));
    }
    return false;
}

/** Insert a comment and keep the thread's and parent's counters in step. */
async function insertComment(db, { thread_id, parent_id = null, author_subject = null, anon_name = null, origin = 'user', message, attachment_ids = [] }) {
    return await db.tx(async () => {
        const thread = await getThread(db, thread_id);
        const staged = await stagedAttachments(db, attachment_ids, author_subject, thread && { service: thread.ref_service, type: thread.ref_type, id: thread.ref_id });
        if (!staged) { const err = new Error('Use attachments uploaded for this item'); err.status = 400; err.code = 'comment.attachment_invalid'; throw err; }
        const info = await db.prepare('INSERT INTO comments (thread_id, parent_id, author_subject, anon_name, origin, message) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
            .run(thread_id, parent_id, author_subject, anon_name, origin, message);
        for (const row of staged) {
            const claimed = await db.prepare('UPDATE comment_attachments SET comment_id = ? WHERE media_id = ? AND comment_id IS NULL').run(info.lastInsertRowid, row.media_id);
            if (!claimed.changes) { const err = new Error('This attachment was already used'); err.status = 400; err.code = 'comment.attachment_invalid'; throw err; }
        }
        await db.prepare('UPDATE comment_threads SET comment_count = comment_count + 1, updated_at = ov_now() WHERE id = ?').run(thread_id);
        if (parent_id) await db.prepare('UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?').run(parent_id);
        const comment = await getComment(db, info.lastInsertRowid);
        await forumLinks.syncComment(db, comment);
        const cthread = await db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(thread_id);
        if (cthread) await require('../events').commentCreated(comment, cthread, { itemPublic: await refIsPublic(db, cthread) });   // community.comment.created
        return comment;
    });
}

/** The author's new text; edited_at records that it changed. → the row */
async function editComment(db, id, message) {
    await db.prepare('UPDATE comments SET message = ?, edited_at = ov_now(), updated_at = ov_now() WHERE id = ? AND deleted_at IS NULL').run(message, id);
    const comment = await getComment(db, id);
    if (comment) await forumLinks.updatePost(db, comment);
    return comment;
}

/** Soft delete; counters recomputed from the rows. → changes */
async function softDeleteComment(db, id, deletedBy = null) {
    return await db.tx(async () => {
        const c = await getComment(db, id);
        if (!c || c.deleted_at) return 0;
        await db.prepare("UPDATE comments SET deleted_at = ov_now(), deleted_by = ?, message = '', updated_at = ov_now() WHERE id = ?").run(deletedBy, id);
        await forumLinks.updatePost(db, await getComment(db, id));
        await db.prepare('DELETE FROM comment_attachments WHERE comment_id = ?').run(id);
        if (c.forum_post_id) await db.prepare('DELETE FROM attachments WHERE post_id = ?').run(c.forum_post_id);
        await db.prepare('UPDATE comment_threads SET comment_count = (SELECT COUNT(*) FROM comments WHERE thread_id = ? AND deleted_at IS NULL), updated_at = ov_now() WHERE id = ?').run(c.thread_id, c.thread_id);
        if (c.parent_id) await db.prepare('UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND deleted_at IS NULL) WHERE id = ?').run(c.parent_id, c.parent_id);
        return 1;
    });
}

/**
 * One page of a thread's top-level comments with up to `replyLimit` replies each.
 *   sort 'old' (default): oldest first, cursor = the last id seen (next page: id > after)
 *   sort 'new': newest first (next page: id < after)
 * Deleted top-level comments appear only while they still have replies (tombstones).
 * → { rows, hasMore } — each row carries .replies (oldest first) and .reply_count
 */
async function listTopLevel(db, threadId, { after = null, sort = 'old', limit = 30, replyLimit = 20 } = {}) {
    const newest = sort === 'new';
    const params = [threadId];
    let cursor = '';
    if (after != null) { cursor = newest ? 'AND id < ?' : 'AND id > ?'; params.push(after); }
    const rows = await db.prepare(`SELECT * FROM comments WHERE thread_id = ? AND parent_id IS NULL AND (deleted_at IS NULL OR reply_count > 0) ${cursor}
                             ORDER BY id ${newest ? 'DESC' : 'ASC'} LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const replies = db.prepare('SELECT * FROM comments WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT ?');
    for (const r of rows) r.replies = await replies.all(r.id, replyLimit);
    const all = rows.concat(rows.flatMap((r) => r.replies || []));
    const attachments = await listAttachments(db, all.map((r) => r.id));
    for (const row of all) row.attachments = attachments.get(row.id) || [];
    return { rows, hasMore };
}

/** Replies of one comment after a cursor (for comments with more replies than the first page shows). */
async function listReplies(db, parentId, { after = null, limit = 50 } = {}) {
    const rows = await db.prepare(`SELECT * FROM comments WHERE parent_id = ? AND deleted_at IS NULL ${after != null ? 'AND id > ?' : ''} ORDER BY id ASC LIMIT ?`)
        .all(...(after != null ? [parentId, after] : [parentId]), limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const attachments = await listAttachments(db, rows.map((r) => r.id));
    for (const row of rows) row.attachments = attachments.get(row.id) || [];
    return { rows, hasMore };
}

/**
 * Top-level comments newest first by offset, each with all its replies (oldest first); deleted ones left
 * out, with their replies. The paste API's list (pastes/service.js keeps its old response shape).
 */
async function listNewest(db, threadId, { limit = 50, offset = 0 } = {}) {
    const top = await db.prepare('SELECT * FROM comments WHERE thread_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(threadId, limit, offset);
    const replies = db.prepare('SELECT * FROM comments WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id ASC');
    for (const c of top) { c.replies = await replies.all(c.id); c.reply_count = c.replies.length; }
    const all = top.concat(top.flatMap((r) => r.replies || []));
    const attachments = await listAttachments(db, all.map((r) => r.id));
    for (const row of all) row.attachments = attachments.get(row.id) || [];
    return top;
}

module.exports = { getThread, getThreadByAccessId, getThreadByRef, resolveThread, setThreadVisibility, getComment, listAttachments, createAttachment, stagedAttachments, insertComment, editComment, softDeleteComment, listTopLevel, listReplies, listNewest };
