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

function getThread(db, id) {
    return db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(id) || null;
}

/** A thread by the unguessable handle browsers use (server/db.js: access_id). */
function getThreadByAccessId(db, accessId) {
    return db.prepare('SELECT * FROM comment_threads WHERE access_id = ?').get(String(accessId)) || null;
}

function getThreadByRef(db, ref) {
    return db.prepare('SELECT * FROM comment_threads WHERE ref_service = ? AND ref_type = ? AND ref_id = ?')
        .get(ref.service, ref.type, String(ref.id)) || null;
}

/**
 * Get-or-create the thread of an entity. Idempotent and race-safe: the UNIQUE(service, type, id)
 * constraint decides, INSERT … ON CONFLICT DO NOTHING never fails, and the row is read back.
 * A label (from a service) refreshes the cached one. → { thread, created }
 */
function resolveThread(db, ref, { label = null, createdBy = null } = {}) {
    return db.transaction(() => {
        const info = db.prepare(`INSERT INTO comment_threads (ref_service, ref_type, ref_id, ref_label, created_by, access_id) VALUES (?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(ref_service, ref_type, ref_id) DO NOTHING`)
            .run(ref.service, ref.type, String(ref.id), label, createdBy, newThreadAccessId());
        if (!info.changes && label) {
            db.prepare('UPDATE comment_threads SET ref_label = ?, updated_at = CURRENT_TIMESTAMP WHERE ref_service = ? AND ref_type = ? AND ref_id = ? AND COALESCE(ref_label, \'\') <> ?')
                .run(label, ref.service, ref.type, String(ref.id), label);
        }
        return { thread: getThreadByRef(db, ref), created: info.changes > 0 };
    })();
}

function setThreadVisibility(db, id, visibility) {
    db.prepare('UPDATE comment_threads SET visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(visibility, id);
    return getThread(db, id);
}

function getComment(db, id) {
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(id) || null;
}

/** Insert a comment and keep the thread's and parent's counters in step. */
function insertComment(db, { thread_id, parent_id = null, author_subject = null, anon_name = null, origin = 'user', message }) {
    return db.transaction(() => {
        const info = db.prepare('INSERT INTO comments (thread_id, parent_id, author_subject, anon_name, origin, message) VALUES (?, ?, ?, ?, ?, ?)')
            .run(thread_id, parent_id, author_subject, anon_name, origin, message);
        db.prepare('UPDATE comment_threads SET comment_count = comment_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread_id);
        if (parent_id) db.prepare('UPDATE comments SET reply_count = reply_count + 1 WHERE id = ?').run(parent_id);
        return getComment(db, info.lastInsertRowid);
    })();
}

/** Soft delete; counters recomputed from the rows. → changes */
function softDeleteComment(db, id, deletedBy = null) {
    return db.transaction(() => {
        const c = getComment(db, id);
        if (!c || c.deleted_at) return 0;
        db.prepare("UPDATE comments SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(deletedBy, id);
        db.prepare('UPDATE comment_threads SET comment_count = (SELECT COUNT(*) FROM comments WHERE thread_id = ? AND deleted_at IS NULL), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(c.thread_id, c.thread_id);
        if (c.parent_id) db.prepare('UPDATE comments SET reply_count = (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND deleted_at IS NULL) WHERE id = ?').run(c.parent_id, c.parent_id);
        return 1;
    })();
}

/**
 * One page of a thread's top-level comments with up to `replyLimit` replies each.
 *   sort 'old' (default): oldest first, cursor = the last id seen (next page: id > after)
 *   sort 'new': newest first (next page: id < after)
 * Deleted top-level comments appear only while they still have replies (tombstones).
 * → { rows, hasMore } — each row carries .replies (oldest first) and .reply_count
 */
function listTopLevel(db, threadId, { after = null, sort = 'old', limit = 30, replyLimit = 20 } = {}) {
    const newest = sort === 'new';
    const params = [threadId];
    let cursor = '';
    if (after != null) { cursor = newest ? 'AND id < ?' : 'AND id > ?'; params.push(after); }
    const rows = db.prepare(`SELECT * FROM comments WHERE thread_id = ? AND parent_id IS NULL AND (deleted_at IS NULL OR reply_count > 0) ${cursor}
                             ORDER BY id ${newest ? 'DESC' : 'ASC'} LIMIT ?`).all(...params, limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const replies = db.prepare('SELECT * FROM comments WHERE parent_id = ? AND deleted_at IS NULL ORDER BY id ASC LIMIT ?');
    for (const r of rows) r.replies = replies.all(r.id, replyLimit);
    return { rows, hasMore };
}

/** Replies of one comment after a cursor (for comments with more replies than the first page shows). */
function listReplies(db, parentId, { after = null, limit = 50 } = {}) {
    const rows = db.prepare(`SELECT * FROM comments WHERE parent_id = ? AND deleted_at IS NULL ${after != null ? 'AND id > ?' : ''} ORDER BY id ASC LIMIT ?`)
        .all(...(after != null ? [parentId, after] : [parentId]), limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    return { rows, hasMore };
}

module.exports = { getThread, getThreadByAccessId, getThreadByRef, resolveThread, setThreadVisibility, getComment, insertComment, softDeleteComment, listTopLevel, listReplies };
