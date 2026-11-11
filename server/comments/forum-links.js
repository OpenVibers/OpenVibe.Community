'use strict';

// A forum post is a view of a comment. The comment remains the source of its text,
// author, order and deletion state; the mapped post gives the forum its usual URLs.
const PUBLIC_PASTE = "p.deleted_at IS NULL AND p.visibility = 'public' AND p.burn_after_read = 0";
const BOARDS = { 'live/vod': 'videos', 'live/clip': 'clips', 'pics/picture': 'pictures' };

async function publicExternalItem(ref, fetchImpl = globalThis.fetch) {
    const board = BOARDS[`${ref.ref_service || ref.service}/${ref.ref_type || ref.type}`];
    const id = String(ref.ref_id || ref.id || '');
    if (!board || (board !== 'pictures' && !/^\d{1,15}$/.test(id)) || (board === 'pictures' && !/^pic_[0-9A-HJKMNP-TV-Z]{26}$/.test(id))) return null;
    const endpoint = board === 'pictures' ? `https://openvibe.pics/api/v1/pictures/${encodeURIComponent(id)}`
        : `https://openvibe.live/api/${board === 'videos' ? 'vods' : 'clips'}/${encodeURIComponent(id)}`;
    try {
        const response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } });
        if (!response.ok) return null;
        const data = await response.json();
        const item = board === 'videos' ? data.vod : board === 'clips' ? data.clip : data;
        if (!item || String(item.id) !== id || (board === 'pictures' ? item.listed !== true || item.state !== 'active'
            : !(item.visibility === 'public' || (!item.visibility && !!item.is_public)))) return null;
        const rawImage = item.thumbnail_url || item.url || null;
        let image = null;
        if (rawImage) {
            try { const u = new URL(rawImage); if (u.protocol === 'https:' && ['openvibe.media', 'openvibe.live', 'openvibe.pics'].includes(u.hostname)) image = u.href; } catch { /* no image */ }
        }
        const url = board === 'pictures' ? `https://openvibe.pics/i/${encodeURIComponent(item.slug || id)}`
            : `https://openvibe.video/${board === 'videos' ? 'v' : 'c'}/${id}`;
        return { board, id, title: String(item.title || item.alt || ref.ref_label || ref.label || (board === 'pictures' ? 'Picture' : board === 'videos' ? 'Video' : 'Clip')).slice(0, 200),
            maker: String(item.username || item.creator_username || data.streamer?.username || '').slice(0, 80), image, url };
    } catch { return null; }
}

async function eligiblePaste(db, thread) {
    if (thread.ref_service !== 'community' || thread.ref_type !== 'paste') return null;
    return await db.prepare(`SELECT p.slug, p.title, p.type, p.owner_subject FROM pastes p WHERE p.slug = ? AND ${PUBLIC_PASTE}`)
        .get(thread.ref_id) || null;
}

async function ensureForumThread(db, thread, external = null) {
    // An already mapped discussion keeps its comments in step while the item is
    // private; the forum read gate decides whether that view is public today.
    if (thread.forum_thread_id) return thread.forum_thread_id;
    const paste = await eligiblePaste(db, thread);
    if (!paste && !external) return null;
    const board = paste ? 'pastes' : external.board;
    const space = await db.prepare('SELECT id FROM spaces WHERE slug = ?').get(board);
    if (!space) return null;
    const key = `${thread.ref_service}:${thread.ref_type}:${thread.ref_id}`;
    const title = paste ? String(paste.title || (paste.type === 'screenshot' ? 'Screenshot' : 'Untitled paste')).slice(0, 200) : external.title;
    const slug = `item-${thread.id}`;
    const info = await db.prepare(`INSERT INTO threads (space_id, slug, title, author_subject, origin, external_key)
        VALUES (?, ?, ?, ?, 'system', ?) ON CONFLICT (space_id, external_key) WHERE external_key IS NOT NULL DO NOTHING RETURNING id`)
        .run(space.id, slug, title, paste ? paste.owner_subject : null, key);
    const row = await db.prepare('SELECT id FROM threads WHERE space_id = ? AND external_key = ?').get(space.id, key);
    if (info.changes) {
        const link = paste ? `/p/${encodeURIComponent(paste.slug)}` : external.url;
        const image = paste ? (paste.type === 'screenshot' ? `\n\n![${title.replace(/[\[\]]/g, '')}](${link}/screenshot)` : '')
            : external.image ? `\n\n![${title.replace(/[\[\]]/g, '')}](${external.image})` : '';
        const maker = !paste && external.maker ? `\n\nShared by ${external.maker.replace(/[\[\]]/g, '')}` : '';
        await db.prepare("INSERT INTO posts (thread_id, origin, is_opening, body_markdown) VALUES (?, 'system', 1, ?)")
            .run(row.id, `[${title.replace(/[\[\]]/g, '')}](${link})${image}${maker}`);
    }
    await db.prepare('UPDATE comment_threads SET forum_thread_id = ? WHERE id = ?').run(row.id, thread.id);
    return row.id;
}

async function syncComment(db, comment, external = null) {
    const thread = await db.prepare('SELECT * FROM comment_threads WHERE id = ?').get(comment.thread_id);
    if (!thread) return;
    const forumId = await ensureForumThread(db, thread, external);
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

module.exports = { BOARDS, publicExternalItem, ensureForumThread, syncComment, updatePost, hidePasteThread };
