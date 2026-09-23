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
 */
const store = require('./store');
const { applyVote, myVotes, parseVote } = require('../votes');
const { fail, isoTime } = require('../http/v1');
const { createAuthors } = require('../identity/authors');
const { createPersonLimiter } = require('../limits');
const { discussionModerator } = require('../identity/capabilities');
const { renderMarkdown } = require('../render/markdown');

const THREADS_PER_PAGE = 25;
const POSTS_PER_PAGE = 50;
const TITLE_MIN = 3, TITLE_MAX = 200;
const BODY_MAX = 40_000;
const THREADS_PER_DAY = 20;

function createForumService({ db, network = null, pulse = null, relay = null, limits = {} } = {}) {
    const authors = createAuthors({ db, network });
    const threadLimiter = createPersonLimiter({ cooldownSec: 30, perMinute: 3, noun: 'threads', ...(limits.threads || {}) });
    const postLimiter = createPersonLimiter({ cooldownSec: 10, perMinute: 6, noun: 'posts', ...(limits.posts || {}) });
    const voteLimiter = createPersonLimiter({ cooldownSec: 0, perMinute: 60, duplicate: false, noun: 'votes', ...(limits.votes || {}) });
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

    function shapeThread(t, space, v, projections, votes) {
        return {
            id: t.id, space: space.slug, slug: t.slug, title: t.title, url: threadUrl(space, t),
            author: authors.author(t.author_subject, t.origin, projections), origin: t.origin,
            pinned: !!t.pinned, locked: !!t.locked, score: t.score, reply_count: t.reply_count,
            last_activity_at: isoTime(t.last_activity_at), created_at: isoTime(t.created_at),
            my_vote: (votes && votes.get(t.id)) || 0,
        };
    }

    function shapePost(p, v, projections) {
        const deleted = !!p.deleted_at;
        const mine = person(v) && p.author_subject === v.subject;
        return {
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
        const projections = await authors.projectionsFor(rows.map((r) => r.author_subject));
        const votes = myVotes(db, 'thread', rows.map((r) => r.id), v && v.subject);
        return rows.map((r) => shapeThread(r, spaceOf(r), v, projections, votes));
    }

    function shapeSpace(s) {
        return {
            slug: s.slug, name: s.name, description: s.description, visibility: s.visibility, url: `/s/${s.slug}`,
            thread_count: s.thread_count != null ? s.thread_count : undefined,
            last_activity_at: s.last_activity_at !== undefined ? isoTime(s.last_activity_at) : undefined,
        };
    }

    function removeThread(v, thread) {
        if (!(person(v) && thread.author_subject === v.subject) && !moderator(v)) fail(403, 'thread.not_yours', 'Only the author or a moderator deletes a thread');
        store.softDeleteThread(db, thread.id);
        if (pulse) hook(() => { pulse.threadGone(thread.id); for (const p of db.prepare('SELECT id FROM posts WHERE thread_id = ?').all(thread.id)) pulse.postGone(p.id); });
        return { ok: true, id: thread.id, deleted: 'thread' };
    }

    // ═════════════════════════════════════════════════════════
    return {
        SORTS: store.SORTS,
        THREADS_PER_PAGE,
        POSTS_PER_PAGE,

        isModerator: moderator,

        /** Spaces this viewer can open, with thread counts. */
        listSpaces(v) {
            const vis = ['public'];
            if (person(v) || moderator(v)) vis.push('members');
            if (moderator(v)) vis.push('staff');
            return { spaces: store.listSpaces(db, vis).map(shapeSpace) };
        },

        space(v, slug) { return { space: shapeSpace(spaceFor(v, slug)) }; },

        /** A page of threads. ?sort=hot|new|top&page= */
        async listThreads(v, spaceSlug, q = {}) {
            const space = spaceFor(v, spaceSlug);
            const sort = store.SORTS.includes(q.sort) ? q.sort : 'hot';
            const page = Math.max(parseInt(q.page, 10) || 1, 1);
            const perPage = Math.min(Math.max(parseInt(q.limit, 10) || THREADS_PER_PAGE, 1), 100);
            const { rows, total } = store.listThreads(db, space.id, { sort, limit: perPage, offset: (page - 1) * perPage, now: q.now || new Date() });
            return {
                space: shapeSpace(space), sort, page, per_page: perPage, total, pages: Math.max(Math.ceil(total / perPage), 1),
                threads: await shapeThreads(rows, () => space, v),
            };
        },

        /** A thread with a page of its posts. ?page= */
        async getThread(v, spaceSlug, threadSlug, q = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const page = Math.max(parseInt(q.page, 10) || 1, 1);
            const { rows, total } = store.listPosts(db, thread.id, { limit: POSTS_PER_PAGE, offset: (page - 1) * POSTS_PER_PAGE });
            const projections = await authors.projectionsFor([thread.author_subject, ...rows.map((p) => p.author_subject)]);
            const votes = myVotes(db, 'thread', [thread.id], v && v.subject);
            return {
                space: shapeSpace(space),
                thread: shapeThread(thread, space, v, projections, votes),
                posts: rows.map((p) => shapePost(p, v, projections)),
                page, per_page: POSTS_PER_PAGE, pages: Math.max(Math.ceil(total / POSTS_PER_PAGE), 1), total,
                viewer: {
                    signed_in: person(v),
                    can_reply: (person(v) || (v && v.origin === 'ai' && v.kind === 'service')) && (!thread.locked || moderator(v)) && (space.visibility !== 'staff' || moderator(v)),
                    can_vote: person(v) && !thread.locked,
                    can_moderate: moderator(v),
                    can_delete: moderator(v) || (person(v) && thread.author_subject === v.subject),
                },
            };
        },

        /** New thread { title, body } → { thread, post } */
        async createThread(v, spaceSlug, body = {}) {
            const space = spaceFor(v, spaceSlug);
            const w = writer(v);
            mayPostIn(v, space);
            const title = cleanTitle(body.title);
            if (title.length < TITLE_MIN || title.length > TITLE_MAX) fail(400, 'thread.invalid_title', `Titles are ${TITLE_MIN} to ${TITLE_MAX} characters`);
            const text = cleanBody(body.body != null ? body.body : body.body_markdown);
            if (w.key) {
                threadLimiter.check(w.key, title);
                if (threadsPerDay > 0 && store.countThreadsSince(db, w.author, '-1 day') >= threadsPerDay) fail(429, 'request.rate_limited', `Daily thread limit reached (${threadsPerDay}/day)`);
            }
            const { thread, post } = store.createThread(db, { space_id: space.id, title, author_subject: w.author, origin: w.origin, body_markdown: text });
            threadLimiter.record(w.key, title);
            if (pulse) hook(() => pulse.threadCreated(thread, space));
            if (relay) hook(() => relay.enqueueThread(thread, space));
            const projections = await authors.projectionsFor([thread.author_subject]);
            return { thread: shapeThread(thread, space, v, projections, null), post: shapePost(post, v, projections) };
        },

        /** Reply { body } → { post } */
        async reply(v, spaceSlug, threadSlug, body = {}) {
            const { space, thread } = threadFor(v, spaceSlug, threadSlug);
            const w = writer(v);
            mayPostIn(v, space);
            if (thread.locked && !moderator(v)) fail(403, 'thread.locked', 'This thread is locked');
            const text = cleanBody(body.body != null ? body.body : body.body_markdown);
            postLimiter.check(w.key, text);
            const post = store.addPost(db, { thread_id: thread.id, author_subject: w.author, origin: w.origin, body_markdown: text });
            postLimiter.record(w.key, text);
            if (pulse) hook(() => pulse.postCreated(post, thread, space));
            const projections = await authors.projectionsFor([post.author_subject]);
            // Where the new post lands: its page in the thread (posts are numbered in id order).
            const position = db.prepare('SELECT COUNT(*) AS c FROM posts WHERE thread_id = ? AND id <= ?').get(thread.id, post.id).c;
            const page = Math.max(Math.ceil(position / POSTS_PER_PAGE), 1);
            return { post: shapePost(post, v, projections), page, url: `${threadUrl(space, thread)}${page > 1 ? `?page=${page}` : ''}#post-${post.id}` };
        },

        /** Edit { body } — the author (not on a locked thread) or a moderator. */
        async editPost(v, postId, body = {}) {
            const { post, thread } = postFor(v, postId);
            const mine = person(v) && post.author_subject === v.subject;
            if (!mine && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator edits a post');
            if (thread.locked && !moderator(v)) fail(403, 'thread.locked', 'This thread is locked');
            const next = store.editPost(db, post.id, cleanBody(body.body != null ? body.body : body.body_markdown), v.subject || v.service || null);
            const projections = await authors.projectionsFor([next.author_subject]);
            return { post: shapePost(next, v, projections) };
        },

        /** Edit history — the author or a moderator. */
        postVersions(v, postId) {
            const { post } = postFor(v, postId);
            if (!(person(v) && post.author_subject === v.subject) && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator sees the history');
            const list = store.listPostVersions(db, post.id).map((r) => ({ ...r, created_at: isoTime(r.created_at) }));
            return { revision: post.revision, versions: list.length ? list : [{ revision: post.revision, body_markdown: post.body_markdown, edited_by: post.author_subject, created_at: isoTime(post.created_at) }] };
        },

        /** Delete a post — the author or a moderator. Deleting the opening post deletes the thread. */
        deletePost(v, postId) {
            const { post, thread } = postFor(v, postId);
            if (!(person(v) && post.author_subject === v.subject) && !moderator(v)) fail(403, 'post.not_yours', 'Only the author or a moderator deletes a post');
            if (post.is_opening) return removeThread(v, thread);
            store.softDeletePost(db, post.id);
            if (pulse) hook(() => pulse.postGone(post.id));
            return { ok: true, id: post.id };
        },

        /** Delete a thread — its author or a moderator. */
        deleteThread(v, spaceSlug, threadSlug) {
            const { thread } = threadFor(v, spaceSlug, threadSlug);
            return removeThread(v, thread);
        },

        /** Vote { value: 1 | -1 | 0 } → { score, upvotes, downvotes, my_vote } */
        voteThread(v, spaceSlug, threadSlug, body = {}) {
            const value = parseVote(body.value);
            if (value === null) fail(400, 'vote.invalid', 'value must be 1, -1 or 0');
            if (!person(v)) fail(401, 'auth.required', 'Sign in to vote');
            const { thread } = threadFor(v, spaceSlug, threadSlug);
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
            const next = store.setThreadFlags(db, thread.id, flags);
            const projections = await authors.projectionsFor([next.author_subject]);
            return { thread: shapeThread(next, space, v, projections, null) };
        },

        /** Latest threads in public spaces, with their opening post (sitemap, feeds). */
        recentPublic({ limit = 50, space = null } = {}) {
            const rows = store.recentThreads(db, { visibilities: ['public'], limit, spaceSlug: space });
            const opening = db.prepare('SELECT body_markdown FROM posts WHERE thread_id = ? AND is_opening = 1');
            return rows.map((t) => ({ ...t, opening: (opening.get(t.id) || {}).body_markdown || '' }));
        },

        publicSpaces() { return store.listSpaces(db, ['public']).map(shapeSpace); },
    };
}

module.exports = { createForumService, THREADS_PER_PAGE, POSTS_PER_PAGE };
