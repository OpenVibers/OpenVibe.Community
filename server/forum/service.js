'use strict';

/**
 * Forum rules — spaces, threads and posts on top of store.js. Used by the JSON API (api.js) and
 * the server-rendered pages (render/forum.js) alike, so both enforce exactly the same things.
 *
 * Spaces:  public  — anyone reads; people post
 *          members — signed-in people read and post (every Network account is a member for now)
 *          staff   — discussion moderators only; looks missing to everyone else
 * Writers: a person (browser JWT subject, or a service with community.post.create naming them in
 *          X-OV-Subject), or AI output from a service (X-OV-Origin: ai — stored with origin 'ai'
 *          and no author, labelled as AI). Anonymous visitors read; they do not post.
 * Locked threads take no replies or votes except from moderators. Authors edit and delete their
 * own posts; moderators (identity/capabilities.js discussionModerator) any, and pin/lock.
 * Edits keep every revision in post_versions.
 *
 * Side effects of a new thread/post: a Pulse item (public spaces) and, for threads, a Discord
 * relay delivery per mapping (relay/discord.js; off unless DISCORD_RELAY_ENABLED).
 *
 * Members-only (OpenVibe.VIP): a space or a single thread can be for one creator's VIP members
 * (members_only_owner = the creator's usr_ subject). Reading its threads and posts, starting a
 * thread, replying, voting and editing need an active entitlement, asked of VIP
 * (POST /policies/evaluate with that owner, through vip/index.js's cache); a gated thread in a gated
 * space needs both. The owner and discussion moderators always pass; every doubt (signed out, VIP
 * down, no grant) is a 403 vip.members_only with the reason and a join link. Listings keep a gated
 * thread's title with its members_only flag, never a body; gated things never reach Pulse, the Discord
 * relay, sitemaps or feeds. Moderators gate spaces (for any creator) and threads; a thread's author
 * gates it to their own members.
 */
const store = require('./store');
const events = require('../events');
const { applyVote, myVotes, parseVote } = require('../votes');
const { fail, isoTime } = require('../http/v1');
const { createAuthors } = require('../identity/authors');
const { createPersonLimiter } = require('../limits');
const { discussionModerator } = require('../identity/capabilities');
const { renderMarkdown } = require('../render/markdown');
const { isUserSubject } = require('../vip');
const { stripImageMetadata } = require('../media/strip-metadata');

const THREADS_PER_PAGE = 25;
/**
 * What a thread is (spaces.thread_kind decides it for new threads) and the statuses it can have:
 *   discussion  no status
 *   request     a feature request, bug or question (Feedback): open → planned → in_progress → done, or declined; staff set it
 *   roadmap     a roadmap item (the Roadmap space; staff and the roadmap sync start them): planned, in_progress, done, paused
 */
const STATUSES = Object.freeze({
    request: ['open', 'planned', 'in_progress', 'done', 'declined'],
    roadmap: ['planned', 'in_progress', 'done', 'paused'],
});
const FIRST_STATUS = { request: 'open', roadmap: 'planned' };
const CATEGORY_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Attachments (WS-J task 2): images only, stored in OpenVibe.Media as med_ objects (media/objects.js).
const ATTACH_MAX = 4;
const ATTACH_BYTES = 8 * 1024 * 1024;
const MED_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The image type from its first bytes (never the name or the declared type), or null. */
function sniffImage(b) {
    if (!Buffer.isBuffer(b) || b.length < 12) return null;
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}
const POSTS_PER_PAGE = 50;
const TITLE_MIN = 3, TITLE_MAX = 200;
const BODY_MAX = 40_000;
const THREADS_PER_DAY = 20;

function createForumService({ db, network = null, pulse = null, relay = null, vip = null, media = null, limits = {} } = {}) {
    const authors = createAuthors({ db, network });
    const threadLimiter = createPersonLimiter({ cooldownSec: 30, perMinute: 3, noun: 'threads', ...(limits.threads || {}) });
    const postLimiter = createPersonLimiter({ cooldownSec: 10, perMinute: 6, noun: 'posts', ...(limits.posts || {}) });
    const voteLimiter = createPersonLimiter({ cooldownSec: 0, perMinute: 60, duplicate: false, noun: 'votes', ...(limits.votes || {}) });
    const uploadLimiter = createPersonLimiter({ cooldownSec: 0, perMinute: 12, duplicate: false, noun: 'uploads', ...(limits.uploads || {}) });
    const threadsPerDay = limits.threadsPerDay != null ? limits.threadsPerDay : THREADS_PER_DAY;
    const hook = (fn) => { try { fn(); } catch (err) { console.warn('[Forum] side effect failed:', err.message); } };

    const moderator = (v) => discussionModerator(v);
    const person = (v) => !!(v && v.subject);

    // ── access ───────────────────────────────────────────────
    function canRead(v, space) {
        if (space.visibility === 'public') return true;
        if (space.visibility === 'members') return person(v) || moderator(v);
        return moderator(v);
    }

    // ── members-only (OpenVibe.VIP) ──────────────────────────
    /** { owner, join_url } for a gated row, null for an open one. */
    async function membersOnly(owner, projections = null) {
        if (!owner) return null;
        const p = (projections || await authors.projectionsFor([owner])).get(owner);
        const username = p && p.username ? p.username : null;
        return { owner, owner_username: username, join_url: vip ? vip.joinUrl(owner, username) : null };
    }

    /**
     * Throw 403 vip.members_only unless the viewer may use every gated level named: the space and/or
     * the thread. Moderators pass; the owner passes; the rest is VIP's answer (fail closed).
     */
    async function requireMembership(v, space, thread = null) {
        if (moderator(v)) return;
        const gates = [];
        if (space && space.members_only_owner) gates.push({ type: 'space', id: space.slug, owner: space.members_only_owner });
        if (thread && thread.members_only_owner) gates.push({ type: 'thread', id: String(thread.id), owner: thread.members_only_owner });
        for (const g of gates) {
            const subject = person(v) ? v.subject : null;
            const d = vip ? await vip.check({ subject, type: g.type, id: g.id, owner: g.owner })
                : (subject && subject === g.owner ? { allow: true } : { allow: false, reason: 'vip_unavailable' });
            if (d.allow) continue;
            const mo = await membersOnly(g.owner);
            fail(403, 'vip.members_only', `Only members of this creator's OpenVibe.VIP can read and post in this ${g.type}`, {
                reason: d.reason || 'denied', gate: g.type, members_only: mo,
                space: { slug: space.slug, name: space.name, description: space.description || null },
                thread: thread ? { slug: thread.slug, title: thread.title } : null,
            });
        }
    }

    /** A creator subject a viewer may gate something to: themselves, or anyone for moderators. */
    function gateOwner(v, requested, fallbackOwner) {
        if (requested === null || requested === false || requested === undefined) return null;
        const owner = requested === true ? fallbackOwner : (typeof requested === 'object' ? requested.owner : requested);
        if (!isUserSubject(owner)) fail(400, 'members_only.invalid_owner', 'members_only.owner must be the creator\'s Network subject (usr_…)');
        if (!moderator(v) && !(person(v) && owner === v.subject)) fail(403, 'members_only.not_yours', 'You can only make things members-only for your own VIP members');
        return owner;
    }

    /** The space, or 404 (staff spaces look missing) / 401 (members-only, signed out). */
    function spaceFor(v, slug) {
        const space = /^[a-z0-9-]{1,40}$/.test(String(slug)) ? store.getSpace(db, slug) : null;
        if (!space || (space.visibility === 'staff' && !moderator(v))) fail(404, 'space.not_found', 'No such space');
        if (!canRead(v, space)) fail(401, 'auth.required', 'Sign in to read this space');
        return space;
    }

    function threadFor(v, spaceSlug, threadSlug) {
        const space = spaceFor(v, spaceSlug);
        const thread = store.getThreadBySlug(db, space.id, threadSlug);
        if (!thread) fail(404, 'thread.not_found', 'No such thread');
        return { space, thread };
    }

    function postFor(v, postId) {
        const post = /^\d{1,15}$/.test(String(postId)) ? store.getPost(db, Number(postId)) : null;
        const thread = post ? store.getThread(db, post.thread_id) : null;
        const space = thread ? store.getSpaceById(db, thread.space_id) : null;
        if (!post || !thread || !space || post.deleted_at) fail(404, 'post.not_found', 'No such post');
        spaceFor(v, space.slug);
        return { post, thread, space };
    }

    /** Who a write is attributed to. → { author, origin, key } (key: the rate-limit bucket) */
    function writer(v) {
        if (v && v.kind === 'service' && v.origin === 'ai') return { author: null, origin: 'ai', key: null };
        if (person(v)) return { author: v.subject, origin: 'user', key: `s:${v.subject}` };
        return fail(401, 'auth.required', 'Sign in with your OpenVibe account to post');
    }

    function mayPostIn(v, space) {
        if (space.visibility === 'staff' && !moderator(v)) fail(403, 'space.staff_only', 'Only staff post here');
    }

    const cleanTitle = (t) => String(t == null ? '' : t).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    function cleanBody(b) {
        const body = String(b == null ? '' : b).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
        if (!body.trim()) fail(400, 'post.empty', 'Write something first');
        if (body.length > BODY_MAX) fail(400, 'post.too_long', `Posts are limited to ${BODY_MAX.toLocaleString('en-US')} characters`);
        return body;
    }

    // ── shapes ───────────────────────────────────────────────
    const threadUrl = (space, t) => `/s/${space.slug}/t/${t.slug}`;

    const shapeCategory = (c) => (c ? { slug: c.slug, name: c.name, description: c.description || null, position: c.position, thread_count: c.thread_count != null ? c.thread_count : undefined } : null);

    function shapeThread(t, space, v, projections, votes) {
        const mo = t.members_only_owner || null;
        const p = mo && projections ? projections.get(mo) : null;
        return {
            id: t.id, space: space.slug, slug: t.slug, title: t.title, url: threadUrl(space, t),
            kind: t.kind || 'discussion', status: t.status || null,
            category: t.category_id ? shapeCategory(store.getCategoryById(db, t.category_id)) : null,
            members_only: mo ? { owner: mo, owner_username: p && p.username ? p.username : null, join_url: vip ? vip.joinUrl(mo, p && p.username) : null } : null,
            author: authors.author(t.author_subject, t.origin, projections), origin: t.origin,
            pinned: !!t.pinned, locked: !!t.locked, score: t.score, reply_count: t.reply_count,
            last_activity_at: isoTime(t.last_activity_at), created_at: isoTime(t.created_at),
            my_vote: (votes && votes.get(t.id)) || 0,
        };
    }

    const shapeAttachment = (a) => ({ media_id: a.media_id, url: a.url, filename: a.filename || null, mime: a.mime, size_bytes: a.size_bytes });
    /** post id → [attachment], in order. */
    function attachmentsOf(postIds) {
        const out = new Map();
        if (!postIds.length) return out;
        const rows = db.prepare(`SELECT * FROM attachments WHERE post_id IN (${postIds.map(() => '?').join(', ')}) ORDER BY post_id, position`).all(...postIds);
        for (const r of rows) { if (!out.has(r.post_id)) out.set(r.post_id, []); out.get(r.post_id).push(shapeAttachment(r)); }
        return out;
    }

    /** The attachments a write names: the writer's own uploads, not yet on a post, at most ATTACH_MAX. → rows */
    function claimable(w, ids) {
        if (ids === undefined || ids === null) return [];
        const list = Array.isArray(ids) ? ids.map(String) : [String(ids)];
        if (list.length > ATTACH_MAX) fail(400, 'attachments.too_many', `At most ${ATTACH_MAX} images per post`);
        if (!w.author && list.length) fail(403, 'attachments.person_only', 'Only people attach images');
        const rows = list.map((id) => (MED_ID.test(id) ? db.prepare('SELECT * FROM attachments WHERE media_id = ?').get(id) : null));
        if (rows.some((r) => !r || r.owner_subject !== w.author || r.post_id != null)) fail(400, 'attachments.invalid', 'Attach images you uploaded for this post');
        return rows;
    }
    function attach(rows, postId) {
        const set = db.prepare('UPDATE attachments SET post_id = ?, position = ? WHERE media_id = ? AND post_id IS NULL');
        rows.forEach((r, i) => set.run(postId, i, r.media_id));
    }

    function shapePost(p, v, projections, attachments = null) {
        const deleted = !!p.deleted_at;
        const mine = person(v) && p.author_subject === v.subject;
        return {
            attachments: deleted ? [] : ((attachments && attachments.get(p.id)) || []),
            id: p.id, thread_id: p.thread_id, is_opening: !!p.is_opening, origin: p.origin,
            author: deleted ? null : authors.author(p.author_subject, p.origin, projections),
            body_markdown: deleted ? null : p.body_markdown,
            body_html: deleted ? null : renderMarkdown(p.body_markdown),
            revision: p.revision, deleted,
            created_at: isoTime(p.created_at), updated_at: isoTime(p.updated_at),
            can_edit: !deleted && (mine || moderator(v)),
        };
    }

    async function shapeThreads(rows, spaceOf, v) {
        const projections = await authors.projectionsFor([...rows.map((r) => r.author_subject), ...rows.map((r) => r.members_only_owner)]);
        const votes = myVotes(db, 'thread', rows.map((r) => r.id), v && v.subject);
        return rows.map((r) => shapeThread(r, spaceOf(r), v, projections, votes));
    }

    function shapeSpace(s, mo = null) {
        return {
            slug: s.slug, name: s.name, description: s.description, visibility: s.visibility, url: `/s/${s.slug}`,
            thread_kind: s.thread_kind || 'discussion', statuses: STATUSES[s.thread_kind] || [],
            members_only: s.members_only_owner ? (mo || { owner: s.members_only_owner, owner_username: null, join_url: vip ? vip.joinUrl(s.members_only_owner) : null }) : null,
            thread_count: s.thread_count != null ? s.thread_count : undefined,
            last_activity_at: s.last_activity_at !== undefined ? isoTime(s.last_activity_at) : undefined,
        };
    }

    /** Newly gated threads leave Pulse and the Discord relay queue at once (reads re-check as well). */
    function hideGated(threadIds) {
        if (!threadIds.length) return;
        if (pulse) hook(() => { for (const id of threadIds) { pulse.threadGone(id); for (const p of db.prepare('SELECT id FROM posts WHERE thread_id = ?').all(id)) pulse.postGone(p.id); } });
        hook(() => {
            const del = db.prepare("DELETE FROM relay_deliveries WHERE thread_id = ? AND status = 'pending'");
            for (const id of threadIds) del.run(id);
        });
    }

    function removeThread(v, thread) {
        const mine = person(v) && thread.author_subject === v.subject;
        if (!mine && !moderator(v)) fail(403, 'thread.not_yours', 'Only the author or a moderator deletes a thread');
        db.transaction(() => {
            store.softDeleteThread(db, thread.id);
            if (!mine) events.moderationAction(v, 'thread.deleted', { type: 'thread', id: String(thread.id), owner_subject: thread.author_subject || null });
        })();
        if (pulse) hook(() => { pulse.threadGone(thread.id); for (const p of db.prepare('SELECT id FROM posts WHERE thread_id = ?').all(thread.id)) pulse.postGone(p.id); });
        return { ok: true, id: thread.id, deleted: 'thread' };
    }

    // ═════════════════════════════════════════════════════════
    return {
        SORTS: store.SORTS,
        THREADS_PER_PAGE,
        POSTS_PER_PAGE,

        isModerator: moderator,
        /** Whether images can be attached (Media and the service principal are configured). */
        attachmentsEnabled: () => !!(media && media.configured),

        /** Spaces this viewer can open, with thread counts (members-only ones carry members_only). */
        async listSpaces(v) {
            const vis = ['public'];
            if (person(v) || moderator(v)) vis.push('members');
            if (moderator(v)) vis.push('staff');
            const rows = store.listSpaces(db, vis);
            const projections = await authors.projectionsFor(rows.map((r) => r.members_only_owner));
            return { spaces: await Promise.all(rows.map(async (r) => shapeSpace(r, await membersOnly(r.members_only_owner, projections)))) };
        },

        async space(v, slug) {
            const s = spaceFor(v, slug);
            return { space: shapeSpace(s, await membersOnly(s.members_only_owner)) };
        },

        /** A page of threads. ?sort=hot|new|top&page=&category=<slug>&status=<status> */
        async listThreads(v, spaceSlug, q = {}) {
            const space = spaceFor(v, spaceSlug);
            await requireMembership(v, space);
            const sort = store.SORTS.includes(q.sort) ? q.sort : 'hot';
            const page = Math.max(parseInt(q.page, 10) || 1, 1);
            const perPage = Math.min(Math.max(parseInt(q.limit, 10) || THREADS_PER_PAGE, 1), 100);
            const category = q.category ? store.getCategory(db, space.id, q.category) : null;
            if (q.category && !category) fail(404, 'category.not_found', 'No such category in this space');
            const statuses = STATUSES[space.thread_kind] || [];
            if (q.status && !statuses.includes(q.status)) fail(400, 'thread.invalid_status', statuses.length ? `status is one of ${statuses.join(', ')}` : 'Threads in this space have no status');
            const { rows, total } = store.listThreads(db, space.id, { sort, limit: perPage, offset: (page - 1) * perPage, now: q.now || new Date(), categoryId: category ? category.id : null, status: q.status || null });
            return {
                space: shapeSpace(space, await membersOnly(space.members_only_owner)), sort, page, per_page: perPage, total, pages: Math.max(Math.ceil(total / perPage), 1),
                categories: store.listCategories(db, space.id).map(shapeCategory), category: category ? category.slug : null, status: q.status || null,
                viewer: { can_start: space.thread_kind !== 'roadmap' || moderator(v), can_moderate: moderator(v) },
                threads: await shapeThreads(rows, () => space, v),
            };
        },

        /**
         * Upload an image to attach to a new thread or reply in this space { buffer, originalname } → { attachment }.
         * People only; PNG, JPEG, GIF or WebP by content, at most 8 MB; metadata (EXIF, GPS) stripped; stored in
         * OpenVibe.Media as a public med_ object the person owns. Name it in `attachments` when posting.
         */
        async uploadAttachment(v, spaceSlug, file) {
            if (!media || !media.configured) fail(503, 'attachments.unavailable', 'Images cannot be attached right now');
            const space = spaceFor(v, spaceSlug);
            if (!person(v)) fail(401, 'auth.required', 'Sign in with your OpenVibe account to attach images');
            mayPostIn(v, space);
            await requireMembership(v, space);
            if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) fail(400, 'attachments.missing', 'Choose an image');
            if (file.buffer.length > ATTACH_BYTES) fail(413, 'attachments.too_large', 'Images are limited to 8 MB');
            const mime = sniffImage(file.buffer);
            if (!mime) fail(415, 'attachments.unsupported', 'Attach a PNG, JPEG, GIF or WebP image');
            uploadLimiter.check(`s:${v.subject}`);
            const buffer = stripImageMetadata(file.buffer, mime);
            const filename = String(file.originalname || 'image').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'image';
            let stored;
            try { stored = await media.uploadImage({ buffer, mime, filename, owner: v.subject }); } catch (err) {
                console.warn('[Forum] attachment upload failed:', err.message);
                fail(err.status === 413 || err.status === 415 ? err.status : 502, 'attachments.upload_failed', 'The image could not be stored. Try again.');
            }
            uploadLimiter.record(`s:${v.subject}`);
            db.prepare('INSERT INTO attachments (media_id, owner_subject, filename, mime, size_bytes, url) VALUES (?, ?, ?, ?, ?, ?)')
                .run(stored.id, v.subject, filename, mime, buffer.length, stored.url);
            return { attachment: shapeAttachment({ media_id: stored.id, url: stored.url, filename, mime, size_bytes: buffer.length }) };
        },

        /** The categories of a space. */
        categories(v, spaceSlug) {
            const space = spaceFor(v, spaceSlug);
            return { space: space.slug, categories: store.listCategories(db, space.id).map(shapeCategory) };
        },

        /** Create or change a category { slug, name, description?, position? } — moderators. */
        putCategory(v, spaceSlug, slug, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators manage categories');
            const space = spaceFor(v, spaceSlug);
            if (!CATEGORY_SLUG.test(String(slug || ''))) fail(400, 'category.invalid_slug', 'A category slug is 1 to 40 lowercase letters, digits and dashes');
            const name = cleanTitle(body.name);
            if (name.length < 2 || name.length > 40) fail(400, 'category.invalid_name', 'Category names are 2 to 40 characters');
            const description = body.description == null ? null : cleanTitle(body.description).slice(0, 200) || null;
            const position = Number.isInteger(Number(body.position)) ? Number(body.position) : 0;
            return { category: shapeCategory(store.upsertCategory(db, space.id, { slug, name, description, position })) };
        },

        /** Delete a category — moderators. Its threads stay, without a category. */
        deleteCategory(v, spaceSlug, slug) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators manage categories');
            const space = spaceFor(v, spaceSlug);
            if (!store.deleteCategory(db, space.id, slug)) fail(404, 'category.not_found', 'No such category in this space');
            return { ok: true };
        },

        /** Move a thread to a category { category: slug | null } — its author or a moderator. */
        async setThreadCategory(v, spaceSlug, threadSlug, body = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            if (!(person(v) && thread.author_subject === v.subject) && !moderator(v)) fail(403, 'thread.not_yours', 'Only the author or a moderator changes the category');
            await requireMembership(v, space, thread);
            const category = body.category ? store.getCategory(db, space.id, body.category) : null;
            if (body.category && !category) fail(404, 'category.not_found', 'No such category in this space');
            const next = store.setThreadCategory(db, thread.id, category ? category.id : null);
            const projections = await authors.projectionsFor([next.author_subject]);
            return { thread: shapeThread(next, space, v, projections, null) };
        },

        /** A request's or roadmap item's status { status } — moderators. */
        async setThreadStatus(v, spaceSlug, threadSlug, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators change a status');
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const statuses = STATUSES[thread.kind] || [];
            if (!statuses.includes(body.status)) fail(400, 'thread.invalid_status', statuses.length ? `status is one of ${statuses.join(', ')}` : 'This thread has no status');
            const next = store.setThreadStatus(db, thread.id, body.status);
            const projections = await authors.projectionsFor([next.author_subject]);
            return { thread: shapeThread(next, space, v, projections, null) };
        },

        /** A thread with a page of its posts. ?page= */
        async getThread(v, spaceSlug, threadSlug, q = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            await requireMembership(v, space, thread);
            const page = Math.max(parseInt(q.page, 10) || 1, 1);
            const { rows, total } = store.listPosts(db, thread.id, { limit: POSTS_PER_PAGE, offset: (page - 1) * POSTS_PER_PAGE });
            const projections = await authors.projectionsFor([thread.author_subject, thread.members_only_owner, space.members_only_owner, ...rows.map((p) => p.author_subject)]);
            const votes = myVotes(db, 'thread', [thread.id], v && v.subject);
            return {
                space: shapeSpace(space, await membersOnly(space.members_only_owner, projections)),
                thread: shapeThread(thread, space, v, projections, votes),
                posts: (() => { const att = attachmentsOf(rows.map((p) => p.id)); return rows.map((p) => shapePost(p, v, projections, att)); })(),
                categories: store.listCategories(db, space.id).map(shapeCategory),
                attachments: { enabled: !!(media && media.configured), max: ATTACH_MAX, max_bytes: ATTACH_BYTES },
                page, per_page: POSTS_PER_PAGE, pages: Math.max(Math.ceil(total / POSTS_PER_PAGE), 1), total,
                viewer: {
                    signed_in: person(v),
                    can_reply: (person(v) || (v && v.origin === 'ai' && v.kind === 'service')) && (!thread.locked || moderator(v)) && (space.visibility !== 'staff' || moderator(v)),
                    can_vote: person(v) && !thread.locked,
                    can_moderate: moderator(v),
                    can_delete: moderator(v) || (person(v) && thread.author_subject === v.subject),
                    can_gate: moderator(v) || (person(v) && thread.author_subject === v.subject),
                },
            };
        },

        /**
         * New thread { title, body, members_only? } → { thread, post }. members_only: true gates it to
         * the author's own VIP members; { owner } names the creator (moderators, or the author themselves).
         */
        async createThread(v, spaceSlug, body = {}) {
            const space = spaceFor(v, spaceSlug);
            const w = writer(v);
            mayPostIn(v, space);
            await requireMembership(v, space);
            const gate = gateOwner(v, body.members_only, w.author);
            const kind = space.thread_kind || 'discussion';
            if (kind === 'roadmap' && !moderator(v)) fail(403, 'space.staff_threads', 'Roadmap items are added by staff. Reply to one, or suggest something in Feedback');
            const category = body.category ? store.getCategory(db, space.id, body.category) : null;
            if (body.category && !category) fail(404, 'category.not_found', 'No such category in this space');
            const title = cleanTitle(body.title);
            if (title.length < TITLE_MIN || title.length > TITLE_MAX) fail(400, 'thread.invalid_title', `Titles are ${TITLE_MIN} to ${TITLE_MAX} characters`);
            const text = cleanBody(body.body != null ? body.body : body.body_markdown);
            const images = claimable(w, body.attachments);
            if (w.key) {
                threadLimiter.check(w.key, title);
                if (threadsPerDay > 0 && store.countThreadsSince(db, w.author, '-1 day') >= threadsPerDay) fail(429, 'request.rate_limited', `Daily thread limit reached (${threadsPerDay}/day)`);
            }
            const { thread, post } = store.createThread(db, { space_id: space.id, title, author_subject: w.author, origin: w.origin, body_markdown: text, members_only_owner: gate,
                kind, status: FIRST_STATUS[kind] || null, category_id: category ? category.id : null });
            threadLimiter.record(w.key, title);
            attach(images, post.id);
            if (pulse) hook(() => pulse.threadCreated(thread, space));
            if (relay) hook(() => relay.enqueueThread(thread, space));
            const projections = await authors.projectionsFor([thread.author_subject, thread.members_only_owner]);
            return { thread: shapeThread(thread, space, v, projections, null), post: shapePost(post, v, projections, attachmentsOf([post.id])) };
        },

        /** Reply { body } → { post } */
        async reply(v, spaceSlug, threadSlug, body = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const w = writer(v);
            mayPostIn(v, space);
            await requireMembership(v, space, thread);
            if (thread.locked && !moderator(v)) fail(403, 'thread.locked', 'This thread is locked');
            const text = cleanBody(body.body != null ? body.body : body.body_markdown);
            const images = claimable(w, body.attachments);
            postLimiter.check(w.key, text);
            const post = store.addPost(db, { thread_id: thread.id, author_subject: w.author, origin: w.origin, body_markdown: text });
            postLimiter.record(w.key, text);
            attach(images, post.id);
            if (pulse) hook(() => pulse.postCreated(post, thread, space));
            const projections = await authors.projectionsFor([post.author_subject]);
            // Where the new post lands: its page in the thread (posts are numbered in id order).
            const position = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id <= ?').get(thread.id, post.id).c;
            const page = Math.max(Math.ceil(position / POSTS_PER_PAGE), 1);
            return { post: shapePost(post, v, projections, attachmentsOf([post.id])), page, url: `${threadUrl(space, thread)}${page > 1 ? `?page=${page}` : ''}#post-${post.id}` };
        },

        /** Edit { body } — the author (not on a locked thread) or a moderator. */
        async editPost(v, postId, body = {}) {
            const { post, thread, space } = postFor(v, postId);
            await requireMembership(v, space, thread);
            const mine = person(v) && post.author_subject === v.subject;
            if (!mine && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator edits a post');
            if (thread.locked && !moderator(v)) fail(403, 'thread.locked', 'This thread is locked');
            const next = store.editPost(db, post.id, cleanBody(body.body != null ? body.body : body.body_markdown), v.subject || v.service || null);
            const projections = await authors.projectionsFor([next.author_subject]);
            return { post: shapePost(next, v, projections) };
        },

        /** Edit history — the author or a moderator. */
        async postVersions(v, postId) {
            const { post, thread, space } = postFor(v, postId);
            await requireMembership(v, space, thread);
            if (!(person(v) && post.author_subject === v.subject) && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator sees the history');
            const list = store.listPostVersions(db, post.id).map((r) => ({ ...r, created_at: isoTime(r.created_at) }));
            return { revision: post.revision, versions: list.length ? list : [{ revision: post.revision, body_markdown: post.body_markdown, edited_by: post.author_subject, created_at: isoTime(post.created_at) }] };
        },

        /** Delete a post — the author or a moderator. Deleting the opening post deletes the thread. */
        deletePost(v, postId) {
            const { post, thread } = postFor(v, postId);
            if (!(person(v) && post.author_subject === v.subject) && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator deletes a post');
            if (post.is_opening) return removeThread(v, thread);
            db.transaction(() => {
                store.softDeletePost(db, post.id);
                if (!(person(v) && post.author_subject === v.subject)) events.moderationAction(v, 'post.deleted', { type: 'post', id: String(post.id), owner_subject: post.author_subject || null }, { details: { thread: String(thread.id) } });
            })();
            if (pulse) hook(() => pulse.postGone(post.id));
            return { ok: true, id: post.id };
        },

        /** Delete a thread — its author or a moderator. */
        deleteThread(v, spaceSlug, threadSlug) {
            const { thread } = threadFor(v, spaceSlug, threadSlug);
            return removeThread(v, thread);
        },

        /** Vote { value: 1 | -1 | 0 } → { score, upvotes, downvotes, my_vote } */
        async voteThread(v, spaceSlug, threadSlug, body = {}) {
            const value = parseVote(body.value);
            if (value === null) fail(400, 'vote.invalid', 'value must be 1, -1 or 0');
            if (!person(v)) fail(401, 'auth.required', 'Sign in to vote');
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            await requireMembership(v, space, thread);
            if (thread.locked) fail(403, 'thread.locked', 'This thread is locked');
            voteLimiter.check(`s:${v.subject}`);
            const out = applyVote(db, 'thread', thread.id, v.subject, value);
            voteLimiter.record(`s:${v.subject}`);
            return { thread_id: thread.id, ...out };
        },

        /** Pin / lock { pinned?, locked? } — moderators. */
        async moderateThread(v, spaceSlug, threadSlug, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators pin or lock threads');
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const flags = {};
            if (body.pinned !== undefined) flags.pinned = !!body.pinned;
            if (body.locked !== undefined) flags.locked = !!body.locked;
            if (!Object.keys(flags).length) fail(400, 'thread.nothing_to_change', 'Send pinned and/or locked');
            const next = db.transaction(() => {
                const r = store.setThreadFlags(db, thread.id, flags);
                if (flags.locked !== undefined && !!thread.locked !== flags.locked) events.moderationAction(v, flags.locked ? 'thread.locked' : 'thread.unlocked', { type: 'thread', id: String(thread.id), owner_subject: thread.author_subject || null });
                return r;
            })();
            const projections = await authors.projectionsFor([next.author_subject]);
            return { thread: shapeThread(next, space, v, projections, null) };
        },

        /**
         * Members-only for a thread { owner: 'usr_…' | null } (or { members_only: … }). Its author gates
         * it to themselves (and opens it again); moderators name any creator. Gating takes it out of
         * Pulse and cancels pending Discord relay deliveries.
         */
        async setThreadMembersOnly(v, spaceSlug, threadSlug, body = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const mine = person(v) && thread.author_subject === v.subject;
            if (!mine && !moderator(v)) fail(403, 'thread.not_yours', 'Only the author or a moderator makes a thread members-only');
            await requireMembership(v, space, null);
            const requested = body.members_only !== undefined ? body.members_only : body.owner;
            const owner = gateOwner(v, requested === undefined ? null : requested, thread.author_subject);
            if (!owner && thread.members_only_owner && !moderator(v) && thread.members_only_owner !== v.subject) fail(403, 'members_only.not_yours', 'Only the creator it is gated to, or a moderator, opens it again');
            const next = store.setThreadMembersOnly(db, thread.id, owner);
            if (owner) hideGated([thread.id]);
            const projections = await authors.projectionsFor([next.author_subject, next.members_only_owner]);
            return { thread: shapeThread(next, space, v, projections, null) };
        },

        /** Members-only for a whole space { owner: 'usr_…' | null } — moderators. */
        async setSpaceMembersOnly(v, spaceSlug, body = {}) {
            if (!moderator(v)) fail(403, 'capability.denied', 'Only moderators make a space members-only');
            const space = spaceFor(v, spaceSlug);
            const requested = body.members_only !== undefined ? body.members_only : body.owner;
            const owner = gateOwner(v, requested === undefined ? null : requested, null);
            const next = store.setSpaceMembersOnly(db, space.id, owner);
            if (owner) hideGated(db.prepare('SELECT id FROM threads WHERE space_id = ?').all(space.id).map((r) => r.id));
            return { space: shapeSpace(next, await membersOnly(next.members_only_owner)) };
        },

        /** Latest threads in public spaces, with their opening post (sitemap, feeds). */
        recentPublic({ limit = 50, space = null } = {}) {
            const rows = store.recentThreads(db, { visibilities: ['public'], limit, spaceSlug: space });
            const opening = db.prepare('SELECT body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1');
            return rows.map((t) => ({ ...t, opening: (opening.get(t.id) || {}).body_markdown || '' }));
        },

        /** Public, open spaces (sitemap, feeds): members-only spaces are left out. */
        publicSpaces() { return store.listSpaces(db, ['public']).filter((s) => !s.members_only_owner).map((s) => shapeSpace(s)); },
    };
}

module.exports = { createForumService, THREADS_PER_PAGE, POSTS_PER_PAGE, STATUSES, ATTACH_MAX, sniffImage };
