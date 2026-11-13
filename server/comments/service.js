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
 *   - read: anyone, except hidden threads (moderators only; everyone else gets 404) and threads of
 *     Community pastes the viewer may not see (pastes/service.js's rule: a private paste is its
 *     owner's and staff's only, a deleted or burned one nobody's — 404, checked on every call, so a
 *     paste made private later takes its thread with it). Everyone is handed a thread's unguessable
 *     access_id (cth_…, what resolve answers as `id`) and addresses the thread only by it, services
 *     included (compatibility register C-14), so nobody can walk thread ids and learn the refs
 *     (unlisted paste slugs, private pages) and comments of entities they were not given.
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
const sectionReactions = require('./section-reactions');
const { fail, isoTime } = require('../http/v1');
const { createAuthors } = require('../identity/authors');
const { createPersonLimiter } = require('../limits');
const { discussionModerator: moderator, checkCapability } = require('../identity/capabilities');
const blocks = require('../identity/blocks');
const commentAttachments = require('./attachments');
const forumLinks = require('./forum-links');

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
    pics: ['picture'],
};
/** Threads that take comments from people only — no anonymous comments (Live's rule for VODs and clips). */
const SIGNED_IN_ONLY = {
    live: ['vod', 'clip'],
    'media-hub': ['video'],
};
const VISIBILITIES = ['public', 'hidden', 'locked'];
const MAX_MESSAGE = 5000;
const ACCESS_ID_RE = /^cth_[A-Za-z0-9_-]{22}$/;
const PAGE = 30;
const REPLY_PAGE = 2;

function createCommentService({ db, network = null, limits = {}, canViewPaste = null, fetchImpl = globalThis.fetch, media = null } = {}) {
    const authors = createAuthors({ db, network });
    const commentLimiter = createPersonLimiter({ cooldownSec: 10, perMinute: 5, noun: 'comments', ...(limits.comments || {}) });
    const voteLimiter = createPersonLimiter({ cooldownSec: 0, perMinute: 60, duplicate: false, noun: 'votes', ...(limits.votes || {}) });

    function refOf(t) {
        const ref = { service: t.ref_service, type: t.ref_type, id: t.ref_id };
        if (t.ref_label) ref.label = t.ref_label;
        return ref;
    }

    /** The id a viewer addresses the thread by: services keep the sequential id they store; browsers get the access id. */
    // The id a thread is named by in every answer: its access id, for services as for browsers (C-14).
    const threadIdFor = (t) => t.access_id;

    function shapeThread(t, v) {
        const id = threadIdFor(t, v);
        if (t.visibility === 'hidden' && !moderator(v)) return { id, access_id: t.access_id, ref: refOf(t), visibility: 'hidden', comment_count: null };
        return { id, access_id: t.access_id, ref: refOf(t), visibility: t.visibility, comment_count: t.comment_count,
            forum_url: t.forum_thread_id ? `/forum/${t.ref_service === 'community' ? 'pastes' : forumLinks.BOARDS[`${t.ref_service}/${t.ref_type}`]}/item-${t.id}` : null,
            created_at: isoTime(t.created_at), updated_at: isoTime(t.updated_at) };
    }

    function shapeComment(c, v, projections, votes, threadId, targets, ownerSubject) {
        const deleted = !!c.deleted_at;
        const a = deleted ? null : authors.author(c.author_subject, c.origin, projections);
        const target = c.reply_to_id ? targets.get(c.reply_to_id) : null;
        const targetAuthor = target && !target.deleted_at ? authors.author(target.author_subject, target.origin, projections) : null;
        const out = {
            id: c.id,
            thread_id: threadId,
            parent_id: c.parent_id || null,
            reply_to_id: c.reply_to_id || null,
            reply_to: target ? { id: target.id, display_name: target.deleted_at ? 'Deleted comment'
                : (targetAuthor && (targetAuthor.display_name || targetAuthor.username)) || target.anon_name || 'Member' } : null,
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
            can_delete: !deleted && (moderator(v) || !!(v && v.subject && (c.author_subject === v.subject || ownerSubject === v.subject))),
            attachments: deleted ? [] : (c.attachments || []).map((row) => commentAttachments.publicReference(row)),
        };
        if (c.replies) out.replies = c.replies.map((r) => shapeComment(r, v, projections, votes, threadId, targets, ownerSubject));
        return out;
    }

    async function shapeComments(rows, v, t) {
        const all = [];
        for (const r of rows) { all.push(r); if (r.replies) all.push(...r.replies); }
        const targets = await store.replyTargets(db, all.map((c) => c.reply_to_id));
        const projections = await authors.projectionsFor(all.map((c) => c.author_subject).concat([...targets.values()].map((c) => c.author_subject)));
        const votes = await myVotes(db, 'comment', all.map((c) => c.id), v && v.subject);
        const ownerSubject = await entityOwner(t);
        return rows.map((r) => shapeComment(r, v, projections, votes, threadIdFor(t, v), targets, ownerSubject));
    }

    /** A thread by its access id, the only id anyone addresses a thread by (C-14). */
    async function threadById(v, id) {
        const s = String(id == null ? '' : id);
        return ACCESS_ID_RE.test(s) ? await store.getThreadByAccessId(db, s) : null;
    }

    /** The thread, or 404 — hidden threads look missing to everyone but moderators. */
    async function visible(v, t) {
        if (!t || (t.visibility === 'hidden' && !moderator(v)) || !await entityVisible(v, t)) fail(404, 'thread.not_found', 'Comment thread not found');
        return t;
    }
    const visibleThread = async (v, id) => await visible(v, await threadById(v, id));

    async function visibleComment(v, id) {
        const c = /^\d{1,15}$/.test(String(id)) ? await store.getComment(db, Number(id)) : null;
        if (!c || c.deleted_at) fail(404, 'comment.not_found', 'Comment not found');
        return { comment: c, thread: await visible(v, await store.getThread(db, c.thread_id)) };
    }

    /**
     * The paste service's one check (shares.canView): a paste that is gone (deleted, burned) is
     * nobody's, a people/private one its owner's, members' and staff's. The app installs the check;
     * without one (a unit test of another product's refs) the old column decides, failing closed.
     */
    async function pasteVisibleTo(v, slug) {
        const p = await pasteStore.getBySlug(db, String(slug));
        if (!p) return false;
        if (canViewPaste) return await canViewPaste(v, p);
        return !(p.visibility === 'private' && !(v && (v.staff || (v.subject && p.owner_subject && v.subject === p.owner_subject))));
    }
    /** An active Pics image is visible to anyone holding its unlisted link and id. */
    async function activePicture(id) {
        if (!/^pic_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id))) return false;
        try {
            const response = await fetchImpl(`https://openvibe.pics/api/v1/pictures/${encodeURIComponent(id)}`, { redirect: 'error', signal: AbortSignal.timeout(3000), headers: { Accept: 'application/json' } });
            if (!response.ok) return false;
            const picture = await response.json();
            return picture.id === id && picture.state === 'active' && typeof picture.slug === 'string';
        } catch { return false; }
    }
    const entityVisible = async (v, t) => t.ref_service === 'pics' && t.ref_type === 'picture' ? activePicture(t.ref_id)
        : !(t.ref_service === 'community' && t.ref_type === 'paste') || await pasteVisibleTo(v, t.ref_id);

    /** Community's own entities must exist (and be visible to the viewer) before anyone opens a thread on them. */
    async function checkCommunityRef(ref, v) {
        if (ref.service === 'pics' && ref.type === 'picture' && !await activePicture(ref.id)) fail(404, 'ref.not_found', 'No such active picture');
        if (ref.service !== 'community') return;
        if (ref.type === 'paste') {
            if (!await pasteVisibleTo(v, ref.id)) fail(404, 'ref.not_found', 'No such paste');
        } else if (ref.type === 'post') {
            const ok = /^\d{1,15}$/.test(ref.id) && await db.prepare(`SELECT 1 FROM posts p JOIN threads t ON t.id = p.thread_id JOIN spaces s ON s.id = t.space_id
                                                                WHERE p.id = ? AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND s.visibility = 'public'`).get(Number(ref.id));
            if (!ok) fail(404, 'ref.not_found', 'No such post');
        }
    }

    const signedInOnly = (t) => (SIGNED_IN_ONLY[t.ref_service] || []).includes(t.ref_type);

    /** Who owns a thread's Community entity (a paste's owner, a forum post's author), or null. */
    async function entityOwner(t) {
        if (t.ref_service !== 'community') return null;
        if (t.ref_type === 'paste') { const p = await pasteStore.getBySlug(db, t.ref_id); return p ? p.owner_subject || null : null; }
        if (t.ref_type === 'post' && /^\d{1,15}$/.test(String(t.ref_id))) { const r = await db.prepare('SELECT author_subject FROM posts WHERE id = ?').get(Number(t.ref_id)); return r ? r.author_subject || null : null; }
        return null;
    }

    /** A comment's words. Empty only with files attached (a picture alone is a comment, 11-12). */
    function cleanMessage(raw, { allowEmpty = false } = {}) {
        const message = String(raw == null ? '' : raw).replace(/\u0000/g, '').trim();
        if (!message && !allowEmpty) fail(400, 'comment.empty', 'Write something or attach a picture');
        if (message.length > MAX_MESSAGE) fail(400, 'comment.too_long', `Comment must be under ${MAX_MESSAGE} characters`);
        return message;
    }

    const cursorId = (after) => {
        if (after == null || after === '') return null;
        if (!/^\d{1,15}$/.test(String(after))) fail(400, 'request.invalid_cursor', '`after` is the id of the last comment you have');
        return Number(after);
    };
    const topCursor = (after) => {
        if (after == null || after === '') return null;
        const match = /^(-?\d{1,12}):(\d{1,15})$/.exec(String(after));
        if (!match) fail(400, 'request.invalid_cursor', '`after` is the last comment cursor');
        return { score: Number(match[1]), id: Number(match[2]) };
    };

    return {
        BROWSER_REF_TYPES,
        SIGNED_IN_ONLY,

        /** POST /threads/resolve { ref } → { thread, created } */
        async resolve(v, body = {}) {
            const ref = body && body.ref;
            const check = ref && typeof ref === 'object' ? contracts.validate('common.entity-ref@1', ref) : { valid: false };
            if (!check.valid) fail(400, 'ref.invalid', 'ref must be an EntityRef {service, type, id}');
            if (v.kind !== 'service') {
                const types = BROWSER_REF_TYPES[ref.service];
                if (!types || !types.includes(ref.type)) fail(403, 'ref.type_not_allowed', `Comments on ${ref.service}/${ref.type} can only be opened by that service`);
            }
            await checkCommunityRef(ref, v);
            // Labels are display caches; only a service's word is taken for them.
            const label = v.kind === 'service' && ref.label ? String(ref.label).slice(0, 200) : null;
            const { thread, created } = await store.resolveThread(db, ref, { label, createdBy: v.subject || (v.kind === 'service' ? v.service : null) });
            return { thread: shapeThread(thread, v), created };
        },

        /** Stage an attachment received by the service that owns the item. */
        async uploadAttachment(v, ref, file) {
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to attach a file');
            const paste = ref && ref.service === 'community' && ref.type === 'paste';
            const owner = ref && ((ref.service === 'live' && ['vod', 'clip'].includes(ref.type) && v.service === 'svc:live')
                || (ref.service === 'pics' && ref.type === 'picture' && v.service === 'svc:media-hub')
                || (ref.service === 'media-hub' && ref.type === 'video' && v.service === 'svc:media-hub'));
            const picture = ref && ref.service === 'pics' && ref.type === 'picture' && v.kind === 'user';
            if (!paste && !picture && !(owner && v.kind === 'service' && checkCapability(v.claims, 'community.comment.write').allowed))
                fail(403, 'attachment.owner_service', 'Upload this attachment through the service that owns the item');
            if (paste || picture) await checkCommunityRef(ref, v);
            if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) fail(400, 'attachment.missing', 'Choose a file');
            if (file.buffer.length > 16 * 1024 * 1024) fail(413, 'attachment.too_large', 'Files are limited to 16 MB');
            if (!media || !media.configured || typeof media.uploadImage !== 'function') fail(503, 'attachment.unavailable', 'Files cannot be attached right now');
            const filename = String(file.originalname || 'file').replace(/[\\/\\\\\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 255) || 'file';
            let uploaded;
            try {
                uploaded = await media.uploadImage({ buffer: file.buffer, filename, mime: file.mimetype || 'application/octet-stream', owner: v.subject,
                    kind: 'file', visibility: 'unlisted', source: 'community.comment' });
            } catch (err) { fail(err.status === 413 ? 413 : 502, 'attachment.upload_failed', 'The file could not be stored. Try again.'); }
            let object;
            try { object = await media.object(uploaded.id); }
            catch (err) { try { await media.deleteObject(uploaded.id); } catch { /* the uploaded object remains private/unlisted */ } fail(502, 'attachment.invalid', 'The stored file could not be verified'); }
            if (!object || !object.owner || object.owner.subject !== v.subject || object.lifecycle_status !== 'ready') {
                try { await media.deleteObject(uploaded.id); } catch { /* best effort cleanup */ }
                fail(400, 'attachment.invalid', 'The stored file is not owned by you');
            }
            const row = await store.createAttachment(db, {
                media_id: uploaded.id, ref_service: ref.service, ref_type: ref.type, ref_id: String(ref.id), owner_subject: v.subject,
                filename: String((object.metadata && object.metadata.filename) || filename).slice(0, 255), mime: String(object.mime_type || file.mimetype || 'application/octet-stream'),
                size_bytes: Number(object.size_bytes) || file.buffer.length, visibility: 'unlisted',
            });
            return { attachment: commentAttachments.publicReference(row) };
        },

        /**
         * The thread of an entity as the entity's own page shows it (Community's paste page): get() found by
         * ref, after the same checks as resolve; reading never opens a thread, so null while nobody has
         * commented, and null for a hidden thread to everyone but moderators.
         */
        async forRef(v, ref, q = {}) {
            await checkCommunityRef(ref, v);
            const t = await store.getThreadByRef(db, ref);
            if (!t || (t.visibility === 'hidden' && !moderator(v))) return null;
            return await this.get(v, t.access_id, q);
        },

        /**
         * GET /threads/:id — the thread and one page of top-level comments (replies nested, up to
         * REPLY_PAGE each). ?after=<cursor>&sort=old|new|top&limit=; ?parent=<id> pages one
         * comment's replies instead.
         */
        async get(v, id, q = {}) {
            const t = await visibleThread(v, id);
            const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE, 1), 100);
            const sort = q.sort === 'new' || q.sort === 'top' ? q.sort : 'old';
            const after = q.parent == null && sort === 'top' ? topCursor(q.after) : cursorId(q.after);
            let rows, hasMore;
            if (q.parent != null && q.parent !== '') {
                const parent = cursorId(q.parent);
                const p = parent != null ? await store.getComment(db, parent) : null;
                if (!p || p.thread_id !== t.id || p.parent_id) fail(404, 'comment.not_found', 'Comment not found');
                ({ rows, hasMore } = await store.listReplies(db, parent, { after, limit }));
            } else {
                ({ rows, hasMore } = await store.listTopLevel(db, t.id, { after, sort, limit, replyLimit: REPLY_PAGE }));
            }
            const comments = await shapeComments(rows, v, t);
            return {
                thread: shapeThread(t, v),
                comments,
                next_cursor: hasMore && rows.length ? (sort === 'top' && q.parent == null
                    ? `${rows[rows.length - 1].score}:${rows[rows.length - 1].id}` : String(rows[rows.length - 1].id)) : null,
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
            const t = await visibleThread(v, id);
            if (t.visibility === 'locked' && !moderator(v)) fail(403, 'thread.locked', 'This comment thread is locked');
            const rawAttachments = body.attachments == null ? [] : (Array.isArray(body.attachments) ? body.attachments : [body.attachments]);
            const message = cleanMessage(body.message, { allowEmpty: rawAttachments.length > 0 });

            let parent = null;
            let parentId = null;
            if (body.parent_id != null && body.parent_id !== '') {
                parent = /^\d{1,15}$/.test(String(body.parent_id)) ? await store.getComment(db, Number(body.parent_id)) : null;
                if (!parent || parent.thread_id !== t.id || parent.deleted_at) fail(400, 'comment.invalid_parent', 'Invalid parent comment');
                // One level of nesting: a reply to a reply joins the top-level comment's replies.
                parentId = parent.parent_id || parent.id;
            }

            const origin = v.origin === 'ai' ? 'ai' : 'user';
            const author = origin === 'ai' ? null : (v.subject || null);
            // Platform blocks: no reply to a comment whose author blocked you (the one answered, and the
            // top-level comment it joins), no comment on a paste or post whose owner blocked you.
            if (parent) {
                const top = parent.parent_id ? await store.getComment(db, parent.parent_id) : null;
                await blocks.refuseIfBlocked(db, [parent.author_subject, top && top.author_subject], author, 'reply to this comment');
            }
            await blocks.refuseIfBlocked(db, [await entityOwner(t)], author, `comment on this ${t.ref_type}`, 'its owner');
            if (!author && origin !== 'ai' && !moderator(v) && signedInOnly(t)) fail(401, 'auth.required', 'Sign in to comment here');
            let anonName = null;
            if (!author && origin !== 'ai') {
                anonName = String(body.anon_name || '').trim().slice(0, 32).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Anonymous';
            }
            const key = author ? `s:${author}` : null;
            // The repeat check reads a picture-only comment by its files, so two different pictures are not "the same comment".
            const said = message || `files:${JSON.stringify(rawAttachments).slice(0, 400)}`;
            commentLimiter.check(key, said);
            if (rawAttachments.length > 4) fail(400, 'comment.attachments_too_many', 'At most four files can be attached to a comment');
            if (rawAttachments.length && !author) fail(401, 'auth.required', 'Sign in to attach a file');
            let attachmentIds = [];
            const composerFiles = [];   // the composer attachments (att_…) the comment names
            if (rawAttachments.length) {
                const refs = [];
                for (const raw of rawAttachments) {
                    // A composer attachment: the person names the file Media stored for them (a video, a picture).
                    if (raw && typeof raw === 'object' && raw.media_attachment_id) {
                        try { composerFiles.push(commentAttachments.composerReference(raw)); }
                        catch (err) { fail(err.status || 400, err.code || 'comment.attachment_invalid', err.message); }
                        continue;
                    }
                    try { refs.push(commentAttachments.cleanReference(raw, author)); }
                    catch (err) { fail(err.status || 400, err.code || 'comment.attachment_invalid', err.message); }
                }
                attachmentIds = refs.map((a) => a.id);
                if (new Set(attachmentIds).size !== attachmentIds.length) fail(400, 'comment.attachment_invalid', 'A file can only be attached once');
                if (composerFiles.length) {
                    // Media owns these files: it says whether the attachment exists, is the person's, and what it
                    // is. An attachment that is not the person's is a 404, exactly like one that does not exist.
                    if (!media || typeof media.attachment !== 'function') fail(503, 'attachment.unavailable', 'Files cannot be attached right now');
                    for (let i = 0; i < composerFiles.length; i++) {
                        const ref = composerFiles[i];
                        let att;
                        try { att = await media.attachment(ref.media_attachment_id, author); }
                        catch (err) {
                            if (err && err.status === 404) fail(404, 'comment.attachment_not_found', 'One of the attached files is not there');
                            fail(502, 'attachment.unavailable', 'One of the attached files could not be checked');
                        }
                        const kind = commentAttachments.allowedKind(att && att.kind, att && att.mime);
                        if (!kind) fail(415, 'comment.attachment_type', 'A comment may carry an image, a video, an audio, a PDF or a text file');
                        composerFiles[i] = { ...att, id: ref.media_attachment_id, kind };
                    }
                }
                if (attachmentIds.length) {
                    const staged = await store.stagedAttachments(db, attachmentIds, author, { service: t.ref_service, type: t.ref_type, id: t.ref_id });
                    if (!staged) fail(400, 'comment.attachment_invalid', 'Attach files uploaded through the service that owns this item');
                    for (const row of staged) {
                        let object;
                        try { object = await media.object(row.media_id); } catch { fail(400, 'comment.attachment_invalid', 'One of the attached files is no longer available'); }
                        if (!object || !object.owner || object.owner.subject !== author || object.lifecycle_status !== 'ready') fail(400, 'comment.attachment_invalid', 'One of the attached files is not yours');
                    }
                }
            }
            const forumItem = forumLinks.BOARDS[`${t.ref_service}/${t.ref_type}`] ? await forumLinks.publicExternalItem(t, fetchImpl) : null;
            // The composer attachments are stored beside the comment (the same table as the old file path).
            const staged = [];
            try {
                for (const att of composerFiles) {
                    const row = await store.createAttachment(db, {
                        media_id: att.id, ref_service: t.ref_service, ref_type: t.ref_type, ref_id: String(t.ref_id),
                        owner_subject: author, filename: String(att.name || 'file').slice(0, 255),
                        mime: String(att.mime || 'application/octet-stream'), size_bytes: Number(att.size) || 0,
                        visibility: 'unlisted', kind: att.kind, url: att.url || null, poster: att.poster || null,
                        playback_url: att.playback && att.playback.url ? att.playback.url : null,
                        playback_mime: att.playback && att.playback.mime ? att.playback.mime : null,
                        playback_ready: att.playback && att.playback.ready ? 1 : 0,
                        duration_s: att.duration_s != null ? Number(att.duration_s) : null,
                        width: att.width != null ? Number(att.width) : null,
                        height: att.height != null ? Number(att.height) : null,
                    });
                    staged.push(row.media_id);
                    attachmentIds.push(row.media_id);
                }
                const c = await store.insertComment(db, { thread_id: t.id, parent_id: parentId, reply_to_id: parent ? parent.id : null,
                    author_subject: author, anon_name: anonName, origin, message, attachment_ids: attachmentIds, forum_item: forumItem });
                // The files live as long as the comment: Media keeps them with it.
                for (const att of composerFiles) {
                    try { await media.keepAttachment(att.id, author, String(c.id)); }
                    catch (err) {
                        console.warn('[Comments] could not keep the attachment ' + att.id + ': ' + err.message);
                        await store.softDeleteComment(db, c.id, v.subject || v.service || null);
                        fail(502, 'attachment.keep_failed', 'One of the attached files could not be kept with the comment');
                    }
                }
                commentLimiter.record(key, said);
                return { comment: (await shapeComments([c], v, t))[0] };
            } catch (err) {
                // A comment that was not written leaves no staged attachment behind.
                if (staged.length) {
                    for (const id of staged) {
                        try { await db.prepare('DELETE FROM comment_attachments WHERE media_id = ? AND comment_id IS NULL').run(id); } catch { /* best effort */ }
                    }
                }
                throw err;
            }
        },

        /**
         * GET /:commentId — one comment and its thread (with the ref), for services only: an owner
         * product checks what a comment belongs to before it edits or deletes it for someone.
         */
        async getComment(v, commentId) {
            if (!v || v.kind !== 'service') fail(404, 'comment.not_found', 'Comment not found');
            const { comment: c, thread: t } = await visibleComment(v, commentId);
            return { comment: (await shapeComments([c], v, t))[0], thread: shapeThread(t, v) };
        },

        /** PATCH /:commentId { message } — the author only. */
        async edit(v, commentId, body = {}) {
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to edit a comment');
            const { comment: c, thread: t } = await visibleComment(v, commentId);
            if (!(c.author_subject && c.author_subject === v.subject)) fail(403, 'comment.not_yours', 'Only the author can edit a comment');
            if (t.visibility === 'locked' && !moderator(v)) fail(403, 'thread.locked', 'This comment thread is locked');
            const message = cleanMessage(body.message);
            const row = message === c.message ? c : await store.editComment(db, c.id, message);
            return { comment: (await shapeComments([row], v, t))[0] };
        },

        /** DELETE /comments/:id — the author or a moderator. */
        async remove(v, commentId, expectedRef = null) {
            const { comment: c, thread: t } = await visibleComment(v, commentId);
            if (expectedRef && (t.ref_service !== expectedRef.service || t.ref_type !== expectedRef.type || t.ref_id !== String(expectedRef.id)))
                fail(404, 'comment.not_found', 'Comment not found');
            if (!(v && v.subject) && !moderator(v)) fail(401, 'auth.required', 'Sign in to delete a comment');
            const isAuthor = !!(v.subject && c.author_subject && c.author_subject === v.subject);
            const isOwner = !!(v.subject && v.subject === await entityOwner(t));
            if (!isAuthor && !isOwner && !moderator(v)) fail(403, 'comment.not_yours', 'Not authorized to delete this comment');
            await store.softDeleteComment(db, c.id, v.subject || v.service || null);
            for (const a of c.attachments || []) {
                if (media && typeof media.deleteObject === 'function') {
                    try { await media.deleteObject(a.media_id); }
                    catch (err) { console.warn(`[Comments] removed attachment ${a.media_id} from comment; Media cleanup failed: ${err.message}`); }
                }
            }
            return { ok: true, id: c.id };
        },

        /** POST /comments/:id/votes { value: 1 | -1 | 0 } */
        async vote(v, commentId, body = {}) {
            const value = parseVote(body.value);
            if (value === null) fail(400, 'vote.invalid', 'value must be 1, -1 or 0');
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to vote');
            const { comment: c, thread: t } = await visibleComment(v, commentId);
            if (t.visibility !== 'public') fail(403, 'thread.locked', 'This comment thread is locked');
            voteLimiter.check(`s:${v.subject}`);
            const out = await applyVote(db, 'comment', c.id, v.subject, value);
            voteLimiter.record(`s:${v.subject}`);
            return { comment_id: c.id, ...out };
        },

        /**
         * POST /comments/threads/:id/section-reactions { section_id, value: 1 | -1 | 0 }
         * A reader says whether a SECTION of the post was good. The section id is the key.
         */
        async sectionReaction(v, threadId, body = {}) {
            const sectionId = String(body.section_id || body.sectionId || '').trim();
            if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sectionId)) fail(400, 'section.invalid_id', 'section_id must be a lowercase slug');
            const value = parseVote(body.value);
            if (value === null) fail(400, 'section.invalid_value', 'value must be 1, -1 or 0');
            if (!(v && v.subject)) fail(401, 'auth.required', 'Sign in to react');
            const t = await visibleThread(v, threadId);
            if (t.visibility !== 'public') fail(403, 'thread.locked', 'This comment thread is locked');
            voteLimiter.check(`s:${v.subject}`);
            const out = await sectionReactions.setSectionReaction(db, t.id, sectionId, v.subject, value);
            voteLimiter.record(`s:${v.subject}`);
            return out;
        },

        /** GET /comments/threads/:id/section-reactions — the counts of every section, and mine. */
        async sectionReactionCounts(v, threadId) {
            const t = await visibleThread(v, threadId);
            const counts = await sectionReactions.sectionReactions(db, t.id);
            const mine = await sectionReactions.mySectionReactions(db, t.id, v && v.subject);
            const sections = {};
            for (const [id, c] of counts) sections[id] = { up: c.up, down: c.down, mine: mine.get(id) || 0 };
            for (const [id, value] of mine) if (!sections[id]) sections[id] = { up: 0, down: 0, mine: value };
            return { thread_id: t.id, sections };
        },

        /** PUT /threads/:id/visibility { visibility } — moderators. */
        async setVisibility(v, id, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators change a thread\'s visibility');
            const visibility = body.visibility;
            if (!VISIBILITIES.includes(visibility)) fail(400, 'thread.invalid_visibility', `visibility must be one of ${VISIBILITIES.join(', ')}`);
            const t = await threadById(v, id);
            if (!t) fail(404, 'thread.not_found', 'Comment thread not found');
            return { thread: shapeThread(await store.setThreadVisibility(db, t.id, visibility), v) };
        },
    };
}

module.exports = { createCommentService, BROWSER_REF_TYPES, SIGNED_IN_ONLY, VISIBILITIES };
