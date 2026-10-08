'use strict';

/**
 * Forum store — pure SQL over spaces / threads / posts / post_versions (server/db.js). Policy
 * lives in service.js, votes in server/votes.js.
 *
 * A thread's opening post is its first post (is_opening = 1); reply_count counts the other
 * live posts. Deletes are soft: a deleted post keeps its place (a tombstone) so the posts
 * after it keep their numbering; a deleted thread disappears from every listing.
 */

const SORTS = ['hot', 'new', 'top', 'active'];

// ── Spaces ───────────────────────────────────────────────────

async function listSpaces(db, visibilities) {
    return await db.prepare(`SELECT s.*, g.slug AS group_slug, g.name AS group_name, g.description AS group_description, g.position AS group_position,
                              ps.slug AS parent_slug, ps.name AS parent_name,
                              (SELECT COUNT(*) FROM threads t WHERE t.space_id = s.id AND t.deleted_at IS NULL) AS thread_count,
                              (SELECT COUNT(*) FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.space_id = s.id AND t.deleted_at IS NULL AND p.deleted_at IS NULL) AS post_count,
                              (SELECT MAX(t.last_activity_at) FROM threads t WHERE t.space_id = s.id AND t.deleted_at IS NULL) AS last_activity_at
                       FROM spaces s LEFT JOIN space_groups g ON g.id = s.group_id LEFT JOIN spaces ps ON ps.id = s.parent_id
                       WHERE s.visibility IN (${visibilities.map(() => '?').join(', ')})
                       ORDER BY g.position IS NULL, g.position, s.position, s.id ASC`).all(...visibilities);
}

/**
 * The newest live post in each space (the board index's "Last post"), members-only threads never.
 * → Map spaceId → { thread_slug, thread_title, author_subject, origin, created_at }
 */
async function lastPosts(db, spaceIds) {
    const out = new Map();
    const q = db.prepare(`SELECT t.slug AS thread_slug, t.title AS thread_title, p.author_subject, p.origin, p.created_at, p.id AS post_id
                          FROM posts p JOIN threads t ON t.id = p.thread_id
                          WHERE t.space_id = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.members_only_owner IS NULL
                          ORDER BY p.id DESC LIMIT 1`);
    for (const id of spaceIds) { const r = await q.get(id); if (r) out.set(id, r); }
    return out;
}

async function listGroups(db) {
    return await db.prepare('SELECT * FROM space_groups ORDER BY position, lower(name)').all();
}

/** Space settings (moderators): style, votes, reactions, group, parent, position, name, description. */
async function updateSpace(db, id, fields) {
    const allowed = ['style', 'votes', 'reactions', 'group_id', 'parent_id', 'position', 'name', 'description', 'thread_kind'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (keys.length) await db.prepare(`UPDATE spaces SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...Object.fromEntries(keys.map((k) => [k, fields[k]])), id });
    return await getSpaceById(db, id);
}

async function createSpace(db, { slug, name, description = null, visibility = 'public', created_by, style = 'feed', votes = 1, reactions = 1, group_id = null, parent_id = null, position = 0, thread_kind = 'discussion' }) {
    await db.prepare(`INSERT INTO spaces (slug, name, description, visibility, created_by, style, votes, reactions, group_id, parent_id, position, thread_kind)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(slug, name, description, visibility, created_by, style, votes, reactions, group_id, parent_id, position, thread_kind);
    return await getSpace(db, slug);
}

/** A person's forum statistics for the author panel. → Map subject → { posts, first_post_at } */
async function authorStats(db, subjects) {
    const out = new Map();
    const list = [...new Set(subjects.filter(Boolean))];
    if (!list.length) return out;
    const rows = await db.prepare(`SELECT author_subject AS s, COUNT(*) AS posts, MIN(created_at) AS first_post_at FROM posts
                             WHERE author_subject IN (${list.map(() => '?').join(', ')}) AND deleted_at IS NULL GROUP BY author_subject`).all(...list);
    for (const r of rows) out.set(r.s, { posts: r.posts, first_post_at: r.first_post_at });
    return out;
}

/** One more view of a thread (the forum's Views column). */
async function bumpViews(db, threadId) {
    await db.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').run(threadId);
}

async function getSpace(db, slug) {
    return await db.prepare('SELECT * FROM spaces WHERE slug = ?').get(String(slug)) || null;
}

async function getSpaceById(db, id) {
    return await db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) || null;
}

// ── Threads ──────────────────────────────────────────────────

/** URL slug from a title: lowercase ascii words joined by '-', at most 60 characters. */
function slugify(title) {
    const s = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
    return s || 'thread';
}

async function uniqueSlug(db, spaceId, base) {
    const taken = db.prepare('SELECT 1 FROM threads WHERE space_id = ? AND slug = ?');
    if (!await taken.get(spaceId, base)) return base;
    for (let n = 2; n < 10_000; n++) {
        const candidate = `${base.slice(0, 54)}-${n}`;
        if (!await taken.get(spaceId, candidate)) return candidate;
    }
    throw new Error('Could not find a free thread slug');
}

async function getThread(db, id) {
    return await db.prepare('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

async function getThreadBySlug(db, spaceId, slug) {
    return await db.prepare('SELECT * FROM threads WHERE space_id = ? AND slug = ? AND deleted_at IS NULL').get(spaceId, String(slug)) || null;
}

/** New thread + its opening post, in one transaction. → { thread, post } */
async function createThread(db, { space_id, title, author_subject = null, origin = 'user', body_markdown, members_only_owner = null, kind = 'discussion', status = null, category_id = null, external_key = null, crosspost_of = null }) {
    return await db.tx(async () => {
        const slug = await uniqueSlug(db, space_id, slugify(title));
        const info = await db.prepare('INSERT INTO threads (space_id, slug, title, author_subject, origin, members_only_owner, kind, status, category_id, external_key, crosspost_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
            .run(space_id, slug, title, author_subject, origin, members_only_owner, kind, status, category_id, external_key, crosspost_of);
        const threadId = info.lastInsertRowid;
        const p = await db.prepare('INSERT INTO posts (thread_id, author_subject, origin, is_opening, body_markdown) VALUES (?, ?, ?, 1, ?) RETURNING id')
            .run(threadId, author_subject, origin, body_markdown);
        const thread = await getThread(db, threadId);
        const space = await db.prepare('SELECT slug, visibility, members_only_owner FROM spaces WHERE id = ?').get(space_id);
        // A members-only (VIP) space's threads are not public either.
        await require('../events').threadCreated(thread, space ? space.slug : String(space_id), space && !space.members_only_owner ? space.visibility : 'members');   // community.thread.created
        return { thread, post: await getPost(db, p.lastInsertRowid) };
    });
}

/**
 * One page of a space's threads. Pinned threads lead every sort.
 *   hot  ov_hot(score, age in hours at `now`) — see server/db.js for the formula
 *   new  newest first
 *   top  highest score first
 * → { rows, total }
 */
async function listThreads(db, spaceId, { sort = 'hot', limit = 25, offset = 0, now = new Date(), categoryId = null, status = null } = {}) {
    const nowSql = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
    const order = {
        hot: 'pinned DESC, ov_hot(score, (julianday(@now) - julianday(created_at)) * 24) DESC, last_activity_at DESC, id DESC',
        new: 'pinned DESC, created_at DESC, id DESC',
        top: 'pinned DESC, score DESC, created_at DESC, id DESC',
        active: 'pinned DESC, last_activity_at DESC, id DESC',
    }[SORTS.includes(sort) ? sort : 'hot'];
    const where = 'space_id = @space AND deleted_at IS NULL AND (@category::bigint IS NULL OR category_id = @category) AND (@status::text IS NULL OR status = @status)';
    const params = { space: spaceId, category: categoryId, status };
    // last_* : the newest live post, for the forum's "Last post" column.
    const rows = await db.prepare(`SELECT threads.*,
                                    (SELECT p.author_subject FROM posts p WHERE p.thread_id = threads.id AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 1) AS last_author_subject,
                                    (SELECT p.origin FROM posts p WHERE p.thread_id = threads.id AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 1) AS last_origin,
                                    (SELECT p.id FROM posts p WHERE p.thread_id = threads.id AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 1) AS last_post_id
                             FROM threads WHERE ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`)
        .all({ ...params, now: nowSql, limit, offset });
    const { total } = await db.prepare(`SELECT COUNT(*) AS total FROM threads WHERE ${where}`).get(params);
    return { rows, total };
}

// ── Categories (WS-J task 1) ─────────────────────────────────

async function listCategories(db, spaceId) {
    return await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM threads t WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS thread_count
                       FROM categories c WHERE c.space_id = ? ORDER BY c.position, lower(c.name)`).all(spaceId);
}

async function getCategory(db, spaceId, slug) {
    return await db.prepare('SELECT * FROM categories WHERE space_id = ? AND slug = ?').get(spaceId, String(slug)) || null;
}

async function getCategoryById(db, id) {
    return id ? await db.prepare('SELECT * FROM categories WHERE id = ?').get(id) || null : null;
}

async function upsertCategory(db, spaceId, { slug, name, description = null, position = 0 }) {
    await db.prepare(`INSERT INTO categories (space_id, slug, name, description, position) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (space_id, slug) DO UPDATE SET name = excluded.name, description = excluded.description, position = excluded.position`)
        .run(spaceId, slug, name, description, position);
    return await getCategory(db, spaceId, slug);
}

/** Threads keep their place; they just lose the category. */
async function deleteCategory(db, spaceId, slug) {
    return await db.tx(async () => {
        const c = await getCategory(db, spaceId, slug);
        if (!c) return false;
        await db.prepare('UPDATE threads SET category_id = NULL WHERE category_id = ?').run(c.id);
        await db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
        return true;
    });
}

async function setThreadCategory(db, id, categoryId) {
    await db.prepare('UPDATE threads SET category_id = ? WHERE id = ?').run(categoryId, id);
    return await getThread(db, id);
}

async function setThreadStatus(db, id, status) {
    await db.prepare('UPDATE threads SET status = ? WHERE id = ?').run(status, id);
    return await getThread(db, id);
}

async function getThreadByKey(db, spaceId, key) {
    return await db.prepare('SELECT * FROM threads WHERE space_id = ? AND external_key = ?').get(spaceId, String(key)) || null;
}

/** Latest threads across spaces of the given visibilities (sitemap, feeds); members-only ones never. */
async function recentThreads(db, { visibilities = ['public'], limit = 50, spaceSlug = null } = {}) {
    return await db.prepare(`SELECT t.*, s.slug AS space_slug, s.name AS space_name FROM threads t JOIN spaces s ON s.id = t.space_id
                       WHERE t.deleted_at IS NULL AND s.visibility IN (${visibilities.map(() => '?').join(', ')}) AND (?::text IS NULL OR s.slug = ?)
                         AND s.members_only_owner IS NULL AND t.members_only_owner IS NULL
                       ORDER BY t.created_at DESC, t.id DESC LIMIT ?`).all(...visibilities, spaceSlug, spaceSlug, limit);
}

async function setThreadFlags(db, id, { pinned, locked }) {
    const sets = [], params = [];
    if (pinned !== undefined) { sets.push('pinned = ?'); params.push(pinned ? 1 : 0); }
    if (locked !== undefined) { sets.push('locked = ?'); params.push(locked ? 1 : 0); }
    if (sets.length) await db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return await getThread(db, id);
}

/** Members-only for a creator's VIP members (owner = their usr_ subject), or open (null). */
async function setThreadMembersOnly(db, id, owner) {
    await db.prepare('UPDATE threads SET members_only_owner = ? WHERE id = ?').run(owner || null, id);
    return await getThread(db, id);
}
async function setSpaceMembersOnly(db, id, owner) {
    await db.prepare('UPDATE spaces SET members_only_owner = ? WHERE id = ?').run(owner || null, id);
    return await getSpaceById(db, id);
}

async function softDeleteThread(db, id) {
    return (await db.prepare('UPDATE threads SET deleted_at = ov_now() WHERE id = ? AND deleted_at IS NULL').run(id)).changes;
}

/** Threads a subject opened since `sinceSql` (a datetime modifier, e.g. '-1 day'); deleted ones count. */
async function countThreadsSince(db, subject, sinceSql) {
    return (await db.prepare("SELECT COUNT(*) AS c FROM threads WHERE author_subject = ? AND created_at > datetime('now', ?)").get(subject, sinceSql)).c;
}

// ── Posts ────────────────────────────────────────────────────

async function getPost(db, id) {
    return await db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || null;
}

/**
 * A reply; bumps the thread's reply_count and last activity. relay_author: the name a reply written
 * on Discord carries (origin 'discord', no author subject; server/relay/inbound.js).
 */
async function addPost(db, { thread_id, author_subject = null, origin = 'user', body_markdown, relay_author = null }) {
    return await db.tx(async () => {
        const info = await db.prepare('INSERT INTO posts (thread_id, author_subject, origin, body_markdown, relay_author) VALUES (?, ?, ?, ?, ?) RETURNING id')
            .run(thread_id, author_subject, origin, body_markdown, relay_author);
        await db.prepare('UPDATE threads SET reply_count = reply_count + 1, last_activity_at = ov_now() WHERE id = ?').run(thread_id);
        const post = await getPost(db, info.lastInsertRowid);
        const thread = await getThread(db, thread_id);
        const space = thread && await db.prepare('SELECT slug, visibility, members_only_owner FROM spaces WHERE id = ?').get(thread.space_id);
        if (thread) await require('../events').postCreated(post, thread, space ? space.slug : String(thread.space_id), space && !space.members_only_owner ? space.visibility : 'members');   // community.post.created
        return post;
    });
}

/** Page of a thread's posts in order (tombstones included). → { rows, total } */
async function listPosts(db, threadId, { limit = 50, offset = 0 } = {}) {
    const rows = await db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY id ASC LIMIT ? OFFSET ?').all(threadId, limit, offset);
    const { total } = await db.prepare('SELECT COUNT(*) AS total FROM posts WHERE thread_id = ?').get(threadId);
    return { rows, total };
}

/**
 * Edit a post: revision + 1 and a post_versions row. The first edit also snapshots the original
 * as revision 1, so the history is complete without copying posts nobody edits (as pastes do).
 */
async function editPost(db, id, body, editedBy = null) {
    return await db.tx(async () => {
        const cur = await getPost(db, id);
        if (!cur || cur.deleted_at || cur.body_markdown === body) return cur;
        if (!await db.prepare('SELECT 1 FROM post_versions WHERE post_id = ? AND revision = ?').get(id, cur.revision)) {
            await db.prepare('INSERT INTO post_versions (post_id, revision, body_markdown, edited_by, created_at) VALUES (?, ?, ?, ?, ?)')
                .run(id, cur.revision, cur.body_markdown, cur.author_subject, cur.updated_at || cur.created_at);
        }
        await db.prepare('UPDATE posts SET body_markdown = ?, revision = revision + 1, updated_at = ov_now() WHERE id = ?').run(body, id);
        const next = await getPost(db, id);
        await db.prepare('INSERT INTO post_versions (post_id, revision, body_markdown, edited_by) VALUES (?, ?, ?, ?)').run(id, next.revision, body, editedBy);
        return next;
    });
}

async function listPostVersions(db, postId) {
    return await db.prepare('SELECT revision, body_markdown, edited_by, created_at FROM post_versions WHERE post_id = ? ORDER BY revision ASC').all(postId);
}

/** Soft delete (body scrubbed); the thread's reply_count is recounted. */
async function softDeletePost(db, id) {
    return await db.tx(async () => {
        const p = await getPost(db, id);
        if (!p || p.deleted_at) return 0;
        await db.prepare("UPDATE posts SET deleted_at = ov_now(), body_markdown = '', updated_at = ov_now() WHERE id = ?").run(id);
        await db.prepare('UPDATE threads SET reply_count = (SELECT COUNT(*) FROM posts WHERE thread_id = ? AND is_opening = 0 AND deleted_at IS NULL) WHERE id = ?').run(p.thread_id, p.thread_id);
        return 1;
    });
}
// ── per-space moderators ─────────────────────────────────────
async function listModerators(db, spaceId) {
    return await db.prepare('SELECT subject_id, added_by, created_at FROM space_moderators WHERE space_id = ? ORDER BY created_at, subject_id').all(spaceId);
}

async function moderatesSpace(db, spaceId, subject) {
    if (!subject) return false;
    return !!await db.prepare('SELECT 1 FROM space_moderators WHERE space_id = ? AND subject_id = ?').get(spaceId, subject);
}

async function addModerator(db, spaceId, subject, addedBy) {
    await db.prepare('INSERT INTO space_moderators (space_id, subject_id, added_by) VALUES (?, ?, ?) ON CONFLICT (space_id, subject_id) DO NOTHING').run(spaceId, subject, addedBy || null);
}

async function removeModerator(db, spaceId, subject) {
    return (await db.prepare('DELETE FROM space_moderators WHERE space_id = ? AND subject_id = ?').run(spaceId, subject)).changes > 0;
}

async function countPostsSince(db, subject, sinceSql) {
    return (await db.prepare("SELECT COUNT(*) AS c FROM posts WHERE author_subject = ? AND created_at > datetime('now', ?)").get(subject, sinceSql)).c;
}

module.exports = {
    SORTS, slugify,
    listSpaces, getSpace, getSpaceById,
    getThread, getThreadBySlug, createThread, listThreads, recentThreads, setThreadFlags, setThreadMembersOnly, setSpaceMembersOnly, softDeleteThread, countThreadsSince,
    listCategories, getCategory, getCategoryById, upsertCategory, deleteCategory, setThreadCategory, setThreadStatus, getThreadByKey,
    lastPosts, listGroups, updateSpace, createSpace, authorStats, bumpViews,
    listModerators, moderatesSpace, addModerator, removeModerator,
    getPost, addPost, listPosts, editPost, listPostVersions, softDeletePost, countPostsSince,
};
