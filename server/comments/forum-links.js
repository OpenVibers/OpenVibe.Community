'use strict';

// A forum post is a view of a comment. The comment remains the source of its text,
// author, order and deletion state; the mapped post gives the forum its usual URLs.
const PUBLIC_PASTE = "p.deleted_at IS NULL AND p.visibility = 'public' AND p.burn_after_read = 0";

async function eligiblePaste(db, thread) {
    if (thread.ref_service !== 'community' || thread.ref_type !== 'paste') return null;
    return await db.prepare(`SELECT p.slug, p.title, p.type, p.owner_subject FROM pastes p WHERE p.slug = ? AND ${PUBLIC_PASTE}`)
        .get(thread.ref_id) || null;
}

async function ensureForumThread(db, thread) {
    const paste = await eligiblePaste(db, thread);
    if (!paste) return null;
    if (thread.forum_thread_id) return thread.forum_thread_id;
    const space = await db.prepare("SELECT id FROM spaces WHERE slug = 'pastes'").get();
    if (!space) return null;
    const key = `community:paste:${paste.slug}`;
    const title = String(paste.title || (paste.type === 'screenshot' ? 'Screenshot' : 'Untitled paste')).slice(0, 200);
    const slug = `item-${thread.id}`;
    const info = await db.prepare(`INSERT INTO threads (space_id, slug, title, author_subject, origin, external_key)
        VALUES (?, ?, ?, ?, 'system', ?) ON CONFLICT (space_id, external_key) WHERE external_key IS NOT NULL DO NOTHING RETURNING id`)
        .run(space.id, slug, title, paste.owner_subject, key);
    const row = await db.prepare('SELECT id FROM threads WHERE space_id = ? AND external_key = ?').get(space.id, key);
    if (info.changes) {
        const link = `/p/${encodeURIComponent(paste.slug)}`;
        const image = paste.type === 'screenshot' ? `\n\n![${title.replace(/[\[\]]/g, '')}](${link}/screenshot)` : '';
        await db.prepare("INSERT INTO posts (thread_id, origin, is_opening, body_markdown) VALUES (?, 'system', 1, ?)")
            .run(row.id, `[${title.replace(/[\[\]]/g, '')}](${link})${image}`);
    }
    await db.prepare('UPDATE comment_threads SET forum_thread_id = ? WHERE id = ?').run(row.id, thread.id);
    return row.id;
}

async function syncComment(db, comment) {
    const thread = await db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(comment.thread_id);
    if (!thread) return;
    const forumId = await ensureForumThread(db, thread);
    if (!forumId) return;
    const existing = await db.prepare('SELECT id FROM posts WHERE comment_id = ?').get(comment.id);
    if (existing) return existing.id;
    const info = await db.prepare(`INSERT INTO posts (thread_id, author_subject, origin, body_markdown, created_at, updated_at, deleted_at, comment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (comment_id) WHERE comment_id IS NOT NULL DO NOTHING RETURNING id`)
        .run(forumId, comment.author_subject, comment.origin, comment.message, comment.created_at, comment.updated_at, comment.deleted_at, comment.id);
    const post = info.changes ? { id: info.lastInsertRowid } : await db.prepare('SELECT id FROM posts WHERE comment_id = ?').get(comment.id);
    await db.prepare('UPDATE comments SET forum_post_id = ? WHERE id = ?').run(post.id, comment.id);
    await db.prepare(`UPDATE threads SET reply_count = (SELECT COUNT(*) FROM posts WHERE thread_id = ? AND is_opening = 0 AND deleted_at IS NULL),
        last_activity_at = (SELECT COALESCE(MAX(created_at), threads.created_at) FROM posts WHERE thread_id = ? AND deleted_at IS NULL) WHERE id = ?`)
        .run(forumId, forumId, forumId);
    return post.id;
}

async function updatePost(db, comment) {
    if (!comment.forum_post_id) return;
    await db.prepare('UPDATE posts SET body_markdown = ?, updated_at = ?, deleted_at = ? WHERE id = ?')
        .run(comment.message, comment.updated_at, comment.deleted_at, comment.forum_post_id);
    const post = await db.prepare('SELECT thread_id FROM posts WHERE id = ?').get(comment.forum_post_id);
    if (post) await db.prepare('UPDATE threads SET reply_count = (SELECT COUNT(*) FROM posts WHERE thread_id = ? AND is_opening = 0 AND deleted_at IS NULL) WHERE id = ?')
        .run(post.thread_id, post.thread_id);
}

async function hidePasteThread(db, slug, visible) {
    await db.prepare(`UPDATE threads SET deleted_at = CASE WHEN ? THEN NULL ELSE ov_now() END
        WHERE external_key = ? AND space_id = (SELECT id FROM spaces WHERE slug = 'pastes')`)
        .run(visible ? 1 : 0, `community:paste:${slug}`);
}

module.exports = { ensureForumThread, syncComment, updatePost, hidePasteThread };
