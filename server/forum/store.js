'use strict';

/**
 * Forum store — pure SQL over spaces / threads / posts / post_versions (server/db.js). Policy
 * lives in service.js, votes in server/votes.js.
 *
 * A thread's opening post is its first post (is_opening = 1); reply_count counts the other
 * live posts. Deletes are soft: a deleted post keeps its place (a tombstone) so the posts
 * after it keep their numbering; a deleted thread disappears from every listing.
 */

const SORTS = ['hot', 'new', 'top'];

// ── Spaces ───────────────────────────────────────────────────

function listSpaces(db, visibilities) {
    return db.prepare(`SELECT s.*,
                              (SELECT COUNT(*) FROM threads t WHERE t.space_id = s.id AND t.deleted_at IS NULL) AS thread_count,
                              (SELECT MAX(t.last_activity_at) FROM threads t WHERE t.space_id = s.id AND t.deleted_at IS NULL) AS last_activity_at
                       FROM spaces s WHERE s.visibility IN (${visibilities.map(() => '?').join(', ')})
                       ORDER BY s.id ASC`).all(...visibilities);
}

function getSpace(db, slug) {
    return db.prepare('SELECT * FROM spaces WHERE slug = ?').get(String(slug)) || null;
}

function getSpaceById(db, id) {
    return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) || null;
}

// ── Threads ──────────────────────────────────────────────────

/** URL slug from a title: lowercase ascii words joined by '-', at most 60 characters. */
function slugify(title) {
    const s = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    return s || 'thread';
}

function uniqueSlug(db, spaceId, base) {
    const taken = db.prepare('SELECT 1 FROM threads WHERE space_id = ? AND slug = ?');
    if (!taken.get(spaceId, base)) return base;
    for (let n = 2; n < 10_000; n++) {
        const candidate = `${base.slice(0, 54)}-${n}`;
        if (!taken.get(spaceId, candidate)) return candidate;
    }
    throw new Error('Could not find a free thread slug');
}

function getThread(db, id) {
    return db.prepare('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

function getThreadBySlug(db, spaceId, slug) {
    return db.prepare('SELECT * FROM threads WHERE space_id = ? AND slug = ? AND deleted_at IS NULL').get(spaceId, String(slug)) || null;
}

/** New thread + its opening post, in one transaction. → { thread, post } */
function createThread(db, { space_id, title, author_subject = null, origin = 'user', body_markdown, members_only_owner = null, kind = 'discussion', status = null, category_id = null, external_key = null }) {
    return db.transaction(() => {
        const slug = uniqueSlug(db, space_id, slugify(title));
        const info = db.prepare('INSERT INTO threads (space_id, slug, title, author_subject, origin, members_only_owner, kind, status, category_id, external_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(space_id, slug, title, author_subject, origin, members_only_owner, kind, status, category_id, external_key);
        const threadId = info.lastInsertRowid;
        const p = db.prepare('INSERT INTO posts (thread_id, author_subject, origin, is_opening, body_markdown) VALUES (?, ?, ?, 1, ?)')
            .run(threadId, author_subject, origin, body_markdown);
        const thread = getThread(db, threadId);
        const space = db.prepare('SELECT slug, visibility FROM spaces WHERE id = ?').get(space_id);
        require('../events').threadCreated(thread, space ? space.slug : String(space_id), space ? space.visibility : 'members');   // community.thread.created
        return { thread, post: getPost(db, p.lastInsertRowid) };
    })();
}

/**
 * One page of a space's threads. Pinned threads lead every sort.
 *   hot  ov_hot(score, age in hours at `now`) — see server/db.js for the formula
 *   new  newest first
 *   top  highest score first
 * → { rows, total }
 */
function listThreads(db, spaceId, { sort = 'hot', limit = 25, offset = 0, now = new Date(), categoryId = null, status = null } = {}) {
    const nowSql = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const order = {
        hot: 'pinned DESC, ov_hot(score, (julianday(@now) - julianday(created_at)) * 24) DESC, last_activity_at DESC, id DESC',
        new: 'pinned DESC, created_at DESC, id DESC',
        top: 'pinned DESC, score DESC, created_at DESC, id DESC',
    }[SORTS.includes(sort) ? sort : 'hot'];
    const where = 'space_id = @space AND deleted_at IS NULL AND (@category IS NULL OR category_id = @category) AND (@status IS NULL OR status = @status)';
    const params = { space: spaceId, category: categoryId, status };
    const rows = db.prepare(`SELECT * FROM threads WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
        .all({ ...params, now: nowSql, limit, offset });
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM threads WHERE ${where}`).get(params);
    return { rows, total };
}

// ── Categories (WS-J task 1) ─────────────────────────────────

function listCategories(db, spaceId) {
    return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM threads t WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS thread_count
                       FROM categories c WHERE c.space_id = ? ORDER BY c.position, c.name COLLATE NOCASE`).all(spaceId);
}

function getCategory(db, spaceId, slug) {
    return db.prepare('SELECT * FROM categories WHERE space_id = ? AND slug = ?').get(spaceId, String(slug)) || null;
}

function getCategoryById(db, id) {
    return id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(id) || null : null;
}

function upsertCategory(db, spaceId, { slug, name, description = null, position = 0 }) {
    db.prepare(`INSERT INTO categories (space_id, slug, name, description, position) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (space_id, slug) DO UPDATE SET name = excluded.name, description = excluded.description, position = excluded.position`)
        .run(spaceId, slug, name, description, position);
    return getCategory(db, spaceId, slug);
}

/** Threads keep their place; they just lose the category. */
function deleteCategory(db, spaceId, slug) {
    return db.transaction(() => {
        const c = getCategory(db, spaceId, slug);
        if (!c) return false;
        db.prepare('UPDATE threads SET category_id = NULL WHERE category_id = ?').run(c.id);
        db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
        return true;
    })();
}

function setThreadCategory(db, id, categoryId) {
    db.prepare('UPDATE threads SET category_id = ? WHERE id = ?').run(categoryId, id);
    return getThread(db, id);
}

function setThreadStatus(db, id, status) {
    db.prepare('UPDATE threads SET status = ? WHERE id = ?').run(status, id);
    return getThread(db, id);
}

function getThreadByKey(db, spaceId, key) {
    return db.prepare('SELECT * FROM threads WHERE space_id = ? AND external_key = ?').get(spaceId, String(key)) || null;
}

/** Latest threads across spaces of the given visibilities (sitemap, feeds); members-only ones never. */
function recentThreads(db, { visibilities = ['public'], limit = 50, spaceSlug = null } = {}) {
    return db.prepare(`SELECT t.*, s.slug AS space_slug, s.name AS space_name FROM threads t JOIN spaces s ON s.id = t.space_id
                       WHERE t.deleted_at IS NULL AND s.visibility IN (${visibilities.map(() => '?').join(', ')}) AND (? IS NULL OR s.slug = ?)
                         AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL
                       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`).all(...visibilities, spaceSlug, spaceSlug, limit);
}

function setThreadFlags(db, id, { pinned, locked }) {
    const sets = [], params = [];
    if (pinned !== undefined) { sets.push('pinned = ?'); params.push(pinned ? 1 : 0); }
    if (locked !== undefined) { sets.push('locked = ?'); params.push(locked ? 1 : 0); }
    if (sets.length) db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return getThread(db, id);
}

/** Members-only for a creator's VIP members (owner = their usr_ subject), or open (null). */
function setThreadMembersOnly(db, id, owner) {
    db.prepare('UPDATE threads SET members_only_owner = ? WHERE id = ?').run(owner || null, id);
    return getThread(db, id);
}
function setSpaceMembersOnly(db, id, owner) {
    db.prepare('UPDATE spaces SET members_only_owner = ? WHERE id = ?').run(owner || null, id);
    return getSpaceById(db, id);
}

function softDeleteThread(db, id) {
    return db.prepare('UPDATE threads SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run(id).changes;
}

/** Threads a subject opened since `sinceSql` (SQLite modifier, e.g. '-1 day'); deleted ones count. */
function countThreadsSince(db, subject, sinceSql) {
    return db.prepare("SELECT COUNT(*) AS c FROM threads WHERE author_subject = ? AND created_at > datetime('now', ?)").get(subject, sinceSql).c;
}

// ── Posts ────────────────────────────────────────────────────

function getPost(db, id) {
    return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || null;
}

/** A reply; bumps the thread's reply_count and last activity. */
function addPost(db, { thread_id, author_subject = null, origin = 'user', body_markdown }) {
    return db.transaction(() => {
        const info = db.prepare('INSERT INTO posts (thread_id, author_subject, origin, body_markdown) VALUES (?, ?, ?, ?)')
            .run(thread_id, author_subject, origin, body_markdown);
        db.prepare('UPDATE threads SET reply_count = reply_count + 1, last_activity_at = CURRENT_TIMESTAMP WHERE id = ?').run(thread_id);
        const post = getPost(db, info.lastInsertRowid);
        const thread = getThread(db, thread_id);
        const space = thread && db.prepare('SELECT slug, visibility FROM spaces WHERE id = ?').get(thread.space_id);
        if (thread) require('../events').postCreated(post, thread, space ? space.slug : String(thread.space_id), space ? space.visibility : 'members');   // community.post.created
        return post;
    })();
}

/** Page of a thread's posts in order (tombstones included). → { rows, total } */
function listPosts(db, threadId, { limit = 50, offset = 0 } = {}) {
    const rows = db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT ? OFFSET ?').all(threadId, limit, offset);
    const { total } = db.prepare('SELECT COUNT(*) AS total FROM posts WHERE thread_id = ?').get(threadId);
    return { rows, total };
}

/**
 * Edit a post: revision + 1 and a post_versions row. The first edit also snapshots the original
 * as revision 1, so the history is complete without copying posts nobody edits (as pastes do).
 */
function editPost(db, id, body, editedBy = null) {
    return db.transaction(() => {
        const cur = getPost(db, id);
        if (!cur || cur.deleted_at || cur.body_markdown === body) return cur;
        if (!db.prepare('SELECT 1 FROM post_versions WHERE post_id = ? AND revision = ?').get(id, cur.revision)) {
            db.prepare('INSERT INTO post_versions (post_id, revision, body_markdown, edited_by, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(id, cur.revision, cur.body_markdown, cur.author_subject, cur.updated_at || cur.created_at);
        }
        db.prepare('UPDATE posts SET body_markdown = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body, id);
        const next = getPost(db, id);
        db.prepare('INSERT INTO post_versions (post_id, revision, body_markdown, edited_by) VALUES (?, ?, ?, ?)').run(id, next.revision, body, editedBy);
        return next;
    })();
}

function listPostVersions(db, postId) {
    return db.prepare('SELECT revision, body_markdown, edited_by, created_at FROM post_versions WHERE post_id = ? ORDER BY revision ASC').all(postId);
}

/** Soft delete (body scrubbed); the thread's reply_count is recounted. */
function softDeletePost(db, id) {
    return db.transaction(() => {
        const p = getPost(db, id);
        if (!p || p.deleted_at) return 0;
        db.prepare("UPDATE posts SET deleted_at = CURRENT_TIMESTAMP, body_markdown = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
        db.prepare('UPDATE threads SET reply_count = (SELECT COUNT(*) FROM posts WHERE thread_id = ? AND is_opening = 0 AND deleted_at IS NULL) WHERE id = ?').run(p.thread_id, p.thread_id);
        return 1;
    })();
}

function countPostsSince(db, subject, sinceSql) {
    return db.prepare("SELECT COUNT(*) AS c FROM posts WHERE author_subject = ? AND created_at > datetime('now', ?)").get(subject, sinceSql).c;
}

module.exports = {
    SORTS, slugify,
    listSpaces, getSpace, getSpaceById,
    getThread, getThreadBySlug, createThread, listThreads, recentThreads, setThreadFlags, setThreadMembersOnly, setSpaceMembersOnly, softDeleteThread, countThreadsSince,
    listCategories, getCategory, getCategoryById, upsertCategory, deleteCategory, setThreadCategory, setThreadStatus, getThreadByKey,
    getPost, addPost, listPosts, editPost, listPostVersions, softDeletePost, countPostsSince,
};
