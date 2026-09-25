'use strict';

/**
 * Typed, reusable comment threads — the comment system every OpenVibe product embeds instead of
 * owning comment tables. A thread belongs to one entity, named by an EntityRef
 * (common.entity-ref@1: { service, type, id, label? }).
 *
 * Who may do what (the viewer comes from identity/viewer.js; api.js has already checked a
 * service's capability for the route):
 *   - resolve: services with community.comment.write may resolve any ref; browsers (signed in or
 *     not) only refs of the types in BROWSER_REF_TYPES. Community's own refs must exist.
 *   - read: anyone, except hidden threads (moderators only; everyone else gets 404). Browsers
 *     address a thread only by its unguessable access_id (cth_…, what resolve hands them as
 *     `id`); the sequential id works for services only, so nobody can walk thread ids and learn
 *     the refs (unlisted paste slugs, private pages) and comments of entities they were not given.
 *   - comment: people (browser or service X-OV-Subject), anonymous with an anon_name, or AI output
 *     from a service (origin ai, never attributed). Not on locked threads (moderators still may).
 *     Threads of the types in SIGNED_IN_ONLY take no anonymous comments (the owner product's rule).
 *     Platform blocks (identity/blocks.js): no reply to a comment whose author blocked you, no comment
 *     on a Community paste or post whose owner blocked you (403 community.blocked).
 *   - edit: the comment's author only (edited_at records it).
 *   - delete: the comment's author, or a moderator.
 *   - one comment with its thread (getComment): services only — comment ids are sequential, so a
 *     browser could otherwise walk them to the refs of threads it was never given.
 *   - vote: people only; 1, -1 or 0 (remove).
 *   - visibility public|hidden|locked: moderators.
 * A moderator is discussion staff (an admin/global_mod browser, or a service vouching with
 * X-OV-Staff and holding community.comment.moderate) or a service holding
 * community.comment.moderate acting as itself (no X-OV-Subject), e.g. an owner service hiding
 * the thread of an entity it took down.
 *
 * Every method returns a plain object for the JSON response or throws ApiError.
 */
const contracts = require('openvibe-contracts');
const store = require('./store');
const pasteStore = require('../pastes/store');
const { applyVote, myVotes, parseVote } = require('../votes');
const { fail, isoTime } = require('../http/v1');
const { createAuthors } = require('../identity/authors');
const { createPersonLimiter } = require('../limits');
const { discussionModerator: moderator } = require('../identity/capabilities');
const blocks = require('../identity/blocks');

/**
 * The entity types a browser may open a thread for (services with community.comment.write: any).
 * Live VODs and clips are not here: a private one is missing to everyone but its owners and staff,
 * and only Live can tell, so only Live opens their threads (and hands the access id to people who
 * may see the item).
 */
const BROWSER_REF_TYPES = {
    live: ['stream', 'channel'],
    media: ['object'],
    community: ['paste', 'post'],
    wiki: ['page'],
    blog: ['post'],
    reviews: ['entity'],
};
/** Threads that take comments from people only — no anonymous comments (Live's rule for VODs and clips). */
const SIGNED_IN_ONLY = {
    live: ['vod', 'clip'],
};
const VISIBILITIES = ['public', 'hidden', 'locked'];
const MAX_MESSAGE = 5000;
const ACCESS_ID_RE = /^cth_[A-Za-z0-9_-]{22}$/;
const PAGE = 30;
const REPLY_PAGE = 20;

function createCommentService({ db, network = null, pastesLocal = false, limits = {} } = {}) {
    const authors = createAuthors({ db, network });
    const commentLimiter = createPersonLimiter({ cooldownSec: 10, perMinute: 5, noun: 'comments', ...(limits.comments || {}) });
    const voteLimiter = createPersonLimiter({ cooldownSec: 0, perMinute: 60, duplicate: false, noun: 'votes', ...(limits.votes || {}) });

    function refOf(t) {
        const ref = { service: t.ref_service, type: t.ref_type, id: t.ref_id };
        if (t.ref_label) ref.label = t.ref_label;
        return ref;
    }

    /** The id a viewer addresses the thread by: services keep the sequential id they store; browsers get the access id. */
    const threadIdFor = (t, v) => (v && v.kind === 'service' ? t.id : t.access_id);

    function shapeThread(t, v) {
        const id = threadIdFor(t, v);
        if (t.visibility === 'hidden' && !moderator(v)) return { id, access_id: t.access_id, ref: refOf(t), visibility: 'hidden', comment_count: null };
        return { id, access_id: t.access_id, ref: refOf(t), visibility: t.visibility, comment_count: t.comment_count, created_at: isoTime(t.created_at), updated_at: isoTime(t.updated_at) };
    }

    function shapeComment(c, v, projections, votes, threadId) {
        const deleted = !!c.deleted_at;
        const a = deleted ? null : authors.author(c.author_subject, c.origin, projections);
        const out = {
            id: c.id,
            thread_id: threadId,
            parent_id: c.parent_id || null,
            origin: c.origin,
            author: a,
            anon_name: deleted || c.author_subject || c.origin === 'ai' ? null : (c.anon_name || 'Anonymous'),
            display_name: deleted ? null : (a ? a.display_name || a.username : (c.anon_name || 'Anonymous')),
            message: deleted ? null : c.message,
            deleted,
            score: c.score, upvotes: c.upvotes, downvotes: c.downvotes,
            my_vote: votes.get(c.id) || 0,
            reply_count: c.reply_count,
            created_at: isoTime(c.created_at),
            updated_at: isoTime(c.updated_at),
            edited_at: deleted ? null : isoTime(c.edited_at),
            can_edit: !deleted && !!(v && v.subject && c.author_subject === v.subject),
            can_delete: !deleted && (moderator(v) || !!(v && v.subject && c.author_subject === v.subject)),
        };
        if (c.replies) out.replies = c.replies.map((r) => shapeComment(r, v, projections, votes, threadId));
        return out;
    }

    async function shapeComments(rows, v, t) {
        const all = [];
        for (const r of rows) { all.push(r); if (r.replies) all.push(...r.replies); }
        const projections = await authors.projectionsFor(all.map((c) => c.author_subject));
        const votes = myVotes(db, 'comment', all.map((c) => c.id), v && v.subject);
        return rows.map((r) => shapeComment(r, v, projections, votes, threadIdFor(t, v)));
    }

    /** A thread by the id this viewer may use: the access id for anyone, the sequential id for services only. */
    function threadById(v, id) {
        const s = String(id == null ? '' : id);
        if (ACCESS_ID_RE.test(s)) return store.getThreadByAccessId(db, s);
        if (v && v.kind === 'service' && /^\d{1,15}$/.test(s)) return store.getThread(db, Number(s));
        return null;
    }

    /** The thread, or 404 — hidden threads look missing to everyone but moderators. */
    function visible(v, t) {
        if (!t || (t.visibility === 'hidden' && !moderator(v))) fail(404, 'thread.not_found', 'Comment thread not found');
        return t;
    }
    const visibleThread = (v, id) => visible(v, threadById(v, id));

    function visibleComment(v, id) {
        const c = /^\d{1,15}$/.test(String(id)) ? store.getComment(db, Number(id)) : null;
        if (!c || c.deleted_at) fail(404, 'comment.not_found', 'Comment not found');
        return { comment: c, thread: visible(v, store.getThread(db, c.thread_id)) };
    }

    /** Community's own entities must exist (and be visible) before anyone opens a thread on them. */
    function checkCommunityRef(ref) {
        if (ref.service !== 'community') return;
        if (ref.type === 'paste') {
            if (!pastesLocal) return; // PASTES_AUTHORITY=live: Live owns them, nothing to check here
            const p = pasteStore.getBySlug(db, ref.id);
            if (!p || p.visibility === 'private') fail(404, 'ref.not_found', 'No such paste');
        } else if (ref.type === 'post') {
            const ok = /^\d{1,15}$/.test(ref.id) && db.prepare(`SELECT 1 FROM posts p JOIN threads t ON t.id = p.thread_id JOIN spaces s ON s.id = t.space_id
                                                                WHERE p.id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND s.visibility = 'public'`).get(Number(ref.id));
            if (!ok) fail(404, 'ref.not_found', 'No such post');
        }
    }

    const signedInOnly = (t) => (SIGNED_IN_ONLY[t.ref_service] || []).includes(t.ref_type);

    /** Who owns a thread's Community entity (a paste's owner, a forum post's author), or null. */
    function entityOwner(t) {
        if (t.ref_service !== 'community') return null;
        if (t.ref_type === 'paste' && pastesLocal) { const p = pasteStore.getBySlug(db, t.ref_id); return p ? p.owner_subject || null : null; }
        if (t.ref_type === 'post' && /^\d{1,15}$/.test(String(t.ref_id))) { const r = db.prepare('SELECT author_subject FROM posts WHERE id = ?').get(Number(t.ref_id)); return r ? r.author_subject || null : null; }
        return null;
    }

    function cleanMessage(raw) {
        const message = String(raw == null ? '' : raw).replace(/\u0000/g, '').trim();
        if (!message) fail(400, 'comment.empty', 'Comment cannot be empty');
        if (message.length > MAX_MESSAGE) fail(400, 'comment.too_long', `Comment must be under ${MAX_MESSAGE} characters`);
        return message;
    }

    const cursorId = (after) => {
        if (after == null || after === '') return null;
        if (!/^\d{1,15}$/.test(String(after))) fail(400, 'request.invalid_cursor', '`after` is the id of the last comment you have');
        return Number(after);
    };

    return {
        BROWSER_REF_TYPES,
        SIGNED_IN_ONLY,

        /** POST /threads/resolve { ref } → { thread, created } */
        resolve(v, body = {}) {
            const ref = body && body.ref;
            const check = ref && typeof ref === 'object' ? contracts.validate('common.entity-ref@1', ref) : { valid: false };
            if (!check.valid) fail(400, 'ref.invalid', 'ref must be an EntityRef {service, type, id}');
            if (v.kind !== 'service') {
                const types = BROWSER_REF_TYPES[ref.service];
                if (!types || !types.includes(ref.type)) fail(403, 'ref.type_not_allowed', `Comments on ${ref.service}/${ref.type} can only be opened by that service`);
            }
            checkCommunityRef(ref);
            // Labels are display caches; only a service's word is taken for them.
            const label = v.kind === 'service' && ref.label ? String(ref.label).slice(0, 200) : null;
            const { thread, created } = store.resolveThread(db, ref, { label, createdBy: v.subject || (v.kind === 'service' ? v.service : null) });
            return { thread: shapeThread(thread, v), created };
        },

        /**
         * GET /threads/:id — the thread and one page of top-level comments (replies nested, up to
         * REPLY_PAGE each). ?after=<last comment id>&sort=old|new&limit=; ?parent=<id> pages one
         * comment's replies instead.
         */
        async get(v, id, q = {}) {
            const t = visibleThread(v, id);
            const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE, 1), 100);
            const after = cursorId(q.after);
            let rows, hasMore;
            if (q.parent != null && q.parent !== '') {
                const parent = cursorId(q.parent);
                const p = parent != null ? store.getComment(db, parent) : null;
                if (!p || p.thread_id !== t.id || p.parent_id) fail(404, 'comment.not_found', 'Comment not found');
                ({ rows, hasMore } = store.listReplies(db, parent, { after, limit }));
            } else {
                ({ rows, hasMore } = store.listTopLevel(db, t.id, { after, sort: q.sort === 'new' ? 'new' : 'old', limit, replyLimit: REPLY_PAGE }));
            }
            const comments = await shapeComments(rows, v, t);
            return {
                thread: shapeThread(t, v),
                comments,
                next_cursor: hasMore && rows.length ? String(rows[rows.length - 1].id) : null,
                viewer: {
                    signed_in: !!(v && v.subject),
                    can_comment: t.visibility === 'public' || moderator(v),
                    can_vote: !!(v && v.subject) && t.visibility === 'public',
                    can_moderate: moderator(v),
                },
            };
        },

        /** POST /threads/:id/comments { message, parent_id?, anon_name? } */
        async add(v, id, body = {}) {
            const t = visibleThread(v, id);
            if (t.visibility === 'locked' && !moderator(v)) fail(403, 'thread.locked', 'This comment thread is locked');
            const message = cleanMessage(body.message);

            let parent = null;
            let parentId = null;
            if (body.parent_id != null && body.parent_id !== '') {
                parent = /^\d{1,15}$/.test(String(body.parent_id)) ? store.getComment(db, Number(body.parent_id)) : null;
                if (!parent || parent.thread_id !== t.id || parent.deleted_at) fail(400, 'comment.invalid_parent', 'Invalid parent comment');
                // One level of nesting: a reply to a reply joins the top-level comment's replies.
                parentId = parent.parent_id || parent.id;
            }

            const origin = v.origin === 'ai' ? 'ai' : 'user';
            const author = origin === 'ai' ? null : (v.subject || null);
            // Platform blocks: no reply to a comment whose author blocked you (the one answered, and the
            // top-level comment it joins), no comment on a paste or post whose owner blocked you.
            if (parent) {
                const top = parent.parent_id ? store.getComment(db, parent.parent_id) : null;
                blocks.refuseIfBlocked(db, [parent.author_subject, top && top.author_subject], author, 'reply to this comment');
            }
            blocks.refuseIfBlocked(db, [entityOwner(t)], author, `comment on this ${t.ref_type}`, 'its owner');
            if (!author && origin !== 'ai' && !moderator(v) && signedInOnly(t)) fail(401, 'auth.required', 'Sign in to comment here');
            let anonName = null;
            if (!author && origin !== 'ai') {
                anonName = String(body.anon_name || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Anonymous';
            }
            const key = author ? `s:${author}` : null;
            commentLimiter.check(key, message);
            const c = store.insertComment(db, { thread_id: t.id, parent_id: parentId, author_subject: author, anon_name: anonName, origin, message });
            commentLimiter.record(key, message);
            return { comment: (await shapeComments([c], v, t))[0] };
        },

        /**
         * GET /:commentId — one comment and its thread (with the ref), for services only: an owner
         * product checks what a comment belongs to before it edits or deletes it for someone.
         */
        async getComment(v, commentId) {
            if (!v || v.kind !== 'service') fail(404, 'comment.not_found', 'Comment not found');
            const { comment: c, thread: t } = visibleComment(v, commentId);
            return { comment: (await shapeComments([c], v, t))[0], thread: shapeThread(t, v) };
        },

        /** PATCH /:commentId { message } — the author only. */
        async edit(v, commentId, body = {}) {
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to edit a comment');
            const { comment: c, thread: t } = visibleComment(v, commentId);
            if (!(c.author_subject && c.author_subject === v.subject)) fail(403, 'comment.not_yours', 'Only the author can edit a comment');
            if (t.visibility === 'locked' && !moderator(v)) fail(403, 'thread.locked', 'This comment thread is locked');
            const message = cleanMessage(body.message);
            const row = message === c.message ? c : store.editComment(db, c.id, message);
            return { comment: (await shapeComments([row], v, t))[0] };
        },

        /** DELETE /comments/:id — the author or a moderator. */
        remove(v, commentId) {
            const { comment: c } = visibleComment(v, commentId);
            if (!(v && v.subject) && !moderator(v)) fail(401, 'auth.required', 'Sign in to delete a comment');
            const isAuthor = !!(v.subject && c.author_subject && c.author_subject === v.subject);
            if (!isAuthor && !moderator(v)) fail(403, 'comment.not_yours', 'Not authorized to delete this comment');
            store.softDeleteComment(db, c.id, v.subject || v.service || null);
            return { ok: true, id: c.id };
        },

        /** POST /comments/:id/votes { value: 1 | -1 | 0 } */
        vote(v, commentId, body = {}) {
            const value = parseVote(body.value);
            if (value === null) fail(400, 'vote.invalid', 'value must be 1, -1 or 0');
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to vote');
            const { comment: c, thread: t } = visibleComment(v, commentId);
            if (t.visibility !== 'public') fail(403, 'thread.locked', 'This comment thread is locked');
            voteLimiter.check(`s:${v.subject}`);
            const out = applyVote(db, 'comment', c.id, v.subject, value);
            voteLimiter.record(`s:${v.subject}`);
            return { comment_id: c.id, ...out };
        },

        /** PUT /threads/:id/visibility { visibility } — moderators. */
        setVisibility(v, id, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators change a thread\'s visibility');
            const visibility = body.visibility;
            if (!VISIBILITIES.includes(visibility)) fail(400, 'thread.invalid_visibility', `visibility must be one of ${VISIBILITIES.join(', ')}`);
            const t = threadById(v, id);
            if (!t) fail(404, 'thread.not_found', 'Comment thread not found');
            return { thread: shapeThread(store.setThreadVisibility(db, t.id, visibility), v) };
        },
    };
}

module.exports = { createCommentService, BROWSER_REF_TYPES, SIGNED_IN_ONLY, VISIBILITIES };
