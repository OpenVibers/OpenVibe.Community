'use strict';

/**
 * Paste service — the rules of the paste system, on top of store.js.
 *
 * This reproduces what OpenVibe.Media's paste API did behind OpenVibe.Live's /api/pastes proxy
 * (status codes, error texts, response shapes, limits), with identity reworked around Network
 * subjects:
 *   - a "limited" caller is one acting as a person (a signed-in browser, or a service naming
 *     X-OV-Subject): Media's paste cooldown / daily cap and comment limits apply to them, just as
 *     they applied to Media's user callers. Anonymous writes are limited per address in api.js.
 *   - private pastes are visible to their owner and to staff only; unlisted ones by slug or to
 *     their owner. Nothing private is ever listed for anyone else.
 *   - AI output (service + X-OV-Origin: ai) is stored with origin 'ai' and no owner.
 *
 * Every method takes the resolved viewer (identity/viewer.js) and returns a plain object for
 * the JSON response, or throws PasteError(status, body).
 */
const crypto = require('crypto');
const store = require('./store');
const { stripImageMetadata } = require('../media/strip-metadata');
const { capabilities } = require('openvibe-contracts');

const DEFAULT_LIMITS = {
    maxSizeKb: 512,
    screenshotMaxSizeMb: 8,
    cooldownSeconds: 30,
    maxPerUserPerDay: 200,
    commentCooldownSeconds: 10,
    commentMaxLength: 2000,
    commentsPerMinute: 5,
    commentAnonAllowed: true,
    viewCooldownSec: 6 * 3600,
    viewEventsPerMinPerIp: 60,
};
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const SERVICE_SLUG_RE = /^[A-Za-z0-9_-]{3,80}$/;
// Literal /api/pastes/<word> routes: a paste with one of these slugs would be unreachable there.
const RESERVED_SLUGS = new Set(['config', 'screenshot', 'bulk', 'admin', 'by-user']);
const BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|preview|discordbot|twitterbot|whatsapp|telegram|curl\/|wget\/|python-requests|go-http-client|headless/i;
const AI_DISPLAY_NAME = 'OpenVibe AI';

class PasteError extends Error {
    constructor(status, body) {
        super(body && body.error);
        this.name = 'PasteError';
        this.status = status;
        this.body = body;
    }
}
const fail = (status, error, extra) => { throw new PasteError(status, { error, ...(extra || {}) }); };

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const intIn = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);

function parseJson(text) { try { return text ? JSON.parse(text) : null; } catch { return null; } }

function createPasteService({ db, network = null, media = null, config = {}, limits = {}, pulse = null } = {}) {
    const L = { ...DEFAULT_LIMITS, ...limits };
    // Pulse (server/pulse) hears about public pastes written by people; a Pulse problem never fails a paste write.
    const tell = (fn) => { if (!pulse) return; try { fn(pulse); } catch (err) { console.warn('[Pastes] pulse:', err.message); } };
    const visitorSecret = process.env.VIEW_HASH_SECRET
        || crypto.createHash('sha256').update(`community-views:${(config.oauth && config.oauth.clientSecret) || crypto.randomBytes(16).toString('hex')}`).digest('hex');

    // ── who may do what ──────────────────────────────────────
    const isOwner = (v, p) => !!(v && v.subject && p.owner_subject && v.subject === p.owner_subject);
    const isStaff = (v) => !!(v && v.staff);
    const canSeeHidden = (v, p) => isOwner(v, p) || isStaff(v);
    // Media applied cooldowns/daily caps to callers acting as a person; not to anonymous app calls.
    const limited = (v) => !!(v && v.subject);
    const hasCap = (v, cap) => !!(v && v.kind === 'service' && capabilities.check(v.claims, cap).allowed);
    const isService = (v) => !!(v && v.kind === 'service');
    const needIdentity = (v) => { if (!v || (!v.subject && !v.staff)) fail(401, 'Authentication required'); };

    /**
     * A paste the viewer may see, or 404: private ones look exactly like missing ones to everyone
     * but their owner and staff — for reads, and for edits/deletes too (no 403 that confirms a slug).
     */
    function visible(v, slug) {
        const p = store.getBySlug(db, String(slug));
        if (!p || (p.visibility === 'private' && !canSeeHidden(v, p))) fail(404, 'Paste not found');
        return p;
    }

    // ── response shapes ──────────────────────────────────────
    function streamIdOf(ref) {
        return ref && ref.service === 'live' && ref.type === 'stream' && /^\d+$/.test(String(ref.id)) ? Number(ref.id) : null;
    }

    function authorFields(subject, origin, projections) {
        if (origin === 'ai') return { username: null, display_name: AI_DISPLAY_NAME, avatar_url: null, profile_color: null };
        const p = subject ? projections.get(subject) : null;
        return {
            username: p ? p.username : null,
            display_name: p ? (p.display_name || p.username) : null,
            avatar_url: p ? p.avatar_url : null,
            profile_color: p ? p.profile_color : null,
        };
    }

    /**
     * Media's pastePublic shape plus the author projection. `user_id` carries the owner's subject
     * id — Community has no numeric user ids — so "user_id is falsy ⇒ anonymous" keeps working,
     * and a comparison against some service's numeric id never matches by accident.
     */
    function shape(p, v, projections) {
        const ref = parseJson(p.stream_ref);
        return {
            unique_views: p.unique_views || 0,
            id: p.id,
            app_id: 'community',
            slug: p.slug,
            user_id: p.owner_subject || null,
            owner_subject: p.owner_subject || null,
            origin: p.origin,
            type: p.type,
            title: p.title,
            content: p.content,
            language: p.language,
            visibility: p.visibility,
            stream_id: streamIdOf(ref),
            stream_ref: ref,
            screenshot_url: p.screenshot_url || null,
            metadata: p.metadata || null,
            burn_after_read: !!p.burn_after_read,
            forked_from: p.forked_from || null,
            pinned: !!p.pinned,
            views: p.views || 0,
            copies: p.copies || 0,
            likes: p.likes || 0,
            is_nsfw: !!p.is_nsfw,
            ai_summary: p.ai_summary || null,
            ai_tags: p.ai_tags || null,
            ai_analyzed_at: p.ai_analyzed_at || null,
            revision: p.revision,
            url: `/p/${p.slug}`,
            raw_url: `/p/${p.slug}/raw`,
            created_at: p.created_at,
            updated_at: p.updated_at,
            is_owner: isOwner(v, p),
            ...authorFields(p.owner_subject, p.origin, projections),
        };
    }

    async function projectionsFor(subjects) {
        if (!network) return store.getProjections(db, subjects);
        try { return await network.projections(subjects); } catch { return store.getProjections(db, subjects); }
    }

    async function shapeMany(rows, v, { preview = false } = {}) {
        const projections = await projectionsFor(rows.map((r) => r.owner_subject));
        return rows.map((r) => {
            const out = shape(r, v, projections);
            if (preview) out.content = r.type === 'paste' ? String(r.content || '').slice(0, 300) : null; // preview only in lists
            return out;
        });
    }
    async function shapeOne(row, v) { return (await shapeMany([row], v))[0]; }

    function shapeComment(c, projections) {
        const out = {
            id: c.id, paste_id: c.paste_id, user_id: c.author_subject || null, author_subject: c.author_subject || null,
            parent_id: c.parent_id || null, anon_name: c.anon_name, message: c.message, is_deleted: c.is_deleted,
            created_at: c.created_at, updated_at: c.updated_at,
            ...authorFields(c.author_subject, 'user', projections),
        };
        if (c.replies) { out.replies = c.replies.map((r) => shapeComment(r, projections)); out.reply_count = c.reply_count; }
        return out;
    }

    // ── rate limits (acting persons) ─────────────────────────
    function pasteRateCheck(v) {
        if (!limited(v)) return;
        if (L.cooldownSeconds > 0) {
            const elapsed = (Date.now() - store.lastPasteTime(db, v.subject)) / 1000;
            if (elapsed < L.cooldownSeconds) {
                const wait = Math.ceil(L.cooldownSeconds - elapsed);
                fail(429, `Please wait ${wait}s before creating another paste`, { cooldown: wait });
            }
        }
        if (L.maxPerUserPerDay > 0 && store.countOwnerSince(db, v.subject, '-1 day') >= L.maxPerUserPerDay) {
            fail(429, `Daily paste limit reached (${L.maxPerUserPerDay}/day)`);
        }
    }

    // Comment limits, per acting person (Media keyed them by address, which behind a proxy is the proxy).
    const recentComments = new Map(); // key → [{ at, message }] newest first
    function commentRateCheck(key, message) {
        const now = Date.now();
        const list = (recentComments.get(key) || []).filter((c) => now - c.at < 60_000);
        recentComments.set(key, list);
        if (list.length && now - list[0].at < L.commentCooldownSeconds * 1000) {
            fail(429, `Please wait ${Math.ceil((L.commentCooldownSeconds * 1000 - (now - list[0].at)) / 1000)}s before commenting again`);
        }
        if (list.length >= L.commentsPerMinute) fail(429, 'Too many comments. Please slow down.');
        if (list.length && list[0].message === message) fail(400, 'Duplicate comment');
    }
    function commentRecorded(key, message) {
        const list = recentComments.get(key) || [];
        list.unshift({ at: Date.now(), message });
        recentComments.set(key, list.slice(0, 20));
    }

    // ── view counting (Media's rules: per visitor, cooldown, no owner/bot views) ──
    const ipBudget = new Map();
    function overBudget(ip) {
        const now = Date.now();
        const b = ipBudget.get(ip);
        if (!b || now - b.start >= 60_000) { ipBudget.set(ip, { start: now, n: 1 }); return false; }
        b.n += 1;
        return b.n > L.viewEventsPerMinPerIp;
    }
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, b] of ipBudget) if (now - b.start > 120_000) ipBudget.delete(k);
        for (const [k, l] of recentComments) if (!l.length || now - l[0].at > 120_000) recentComments.delete(k);
        try { store.pruneVisits(db, 30); } catch { /* db closed in tests */ }
    }, 10 * 60_000);
    if (sweep.unref) sweep.unref();

    function countView(v, p, { ip, userAgent } = {}) {
        if (BOT_UA.test(String(userAgent || ''))) return;
        if (overBudget(ip || 'unknown')) return;
        const visitor = v && v.subject ? `u:${v.subject}` : `ip:${crypto.createHmac('sha256', visitorSecret).update(String(ip || 'unknown')).digest('hex').slice(0, 32)}`;
        const r = store.recordVisit(db, p.id, visitor, L.viewCooldownSec);
        p.views = r.views; p.unique_views = r.unique_views;
    }

    /** Burn-after-read: the paste is gone the moment this read makes it spent. */
    function burn(p) {
        store.softDelete(db, p.id);
        fail(410, 'This paste has been burned after reading.');
    }

    // ── validation helpers ───────────────────────────────────
    function visibilityOf(value, owned) {
        const vis = ['unlisted', 'private'].includes(value) ? value : 'public';
        // Nobody could ever open an ownerless private paste; it becomes unlisted instead.
        return vis === 'private' && !owned ? 'unlisted' : vis;
    }

    function streamRefFor(v, body) {
        if (v.kind === 'service' && v.sourceRef) return JSON.stringify(v.sourceRef);
        const sid = body.stream_id;
        if (sid != null && /^\d{1,18}$/.test(String(sid))) return JSON.stringify({ service: 'live', type: 'stream', id: String(sid) });
        return null;
    }

    /** Service callers may carry structured metadata (AI moments); browsers may not. */
    function serviceMetadata(v, body) {
        if (!isService(v) || body.metadata == null || body.metadata === '') return null;
        const obj = typeof body.metadata === 'string' ? parseJson(body.metadata) : body.metadata;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(400, 'metadata must be a JSON object');
        const text = JSON.stringify(obj);
        if (text.length > 16 * 1024) fail(400, 'metadata too large (max 16 KB)');
        return obj;
    }

    function aiFields(v, body) {
        if (!isService(v) || body.ai_summary == null) return {};
        const tags = body.ai_tags == null ? null : (typeof body.ai_tags === 'string' ? body.ai_tags : JSON.stringify(body.ai_tags)).slice(0, 2000);
        return { ai_summary: String(body.ai_summary).slice(0, 2000), ai_tags: tags, ai_analyzed_at: new Date().toISOString().replace('T', ' ').slice(0, 19) };
    }

    function slugFor(v, body) {
        if (!isService(v) || body.slug == null || body.slug === '') return store.generateSlug(db);
        const slug = String(body.slug);
        if (!SERVICE_SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug.toLowerCase())) fail(400, 'Invalid slug');
        if (db.prepare('SELECT 1 FROM pastes WHERE slug = ?').get(slug)) fail(409, 'Slug already taken');
        return slug;
    }

    function created(row, extra = {}) {
        tell((p) => p.pasteCreated(row));
        return { id: row.id, slug: row.slug, url: `/p/${row.slug}`, ...extra };
    }

    // ═════════════════════════════════════════════════════════
    return {
        PasteError,
        limits: L,

        /** GET /api/pastes */
        async list(v, q = {}) {
            const needsAi = truthy(q.needs_ai);
            if (needsAi && !hasCap(v, 'community.paste.moderate')) fail(403, 'needs_ai requires community.paste.moderate');
            const limit = intIn(q.limit, 50, 1, 200);
            const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
            const opts = { limit, offset, type: q.type, sort: q.sort, origin: q.origin, needsAi, search: q.search ? String(q.search).slice(0, 200) : null };
            // ?username= lists one person's pastes (Live resolved it to its own id; we go through
            // the projection cache). Their own unlisted/private ones only for them (or staff).
            if (q.username && q.username !== 'all') {
                const subject = store.subjectsByUsername(db, q.username)[0];
                if (!subject) return { pastes: [], total: 0, limit: 0, offset: 0, hasMore: false };
                opts.ownerSubject = subject;
                if (truthy(q.include_unlisted) && (v.subject === subject || isStaff(v))) opts.includeHidden = true;
            }
            const { rows, total } = store.listPastes(db, opts);
            return { pastes: await shapeMany(rows, v, { preview: true }), total, limit, offset };
        },

        /** GET /api/pastes/by-user/:username */
        async byUser(v, username, q = {}) {
            const subject = store.subjectsByUsername(db, username)[0];
            if (!subject) fail(404, 'User not found');
            const limit = intIn(q.limit, 30, 1, 100);
            const includeHidden = v.subject === subject;
            const { rows, total } = store.listPastes(db, { ownerSubject: subject, includeHidden, limit, offset: 0, sort: q.sort === 'oldest' ? 'oldest' : 'newest' });
            const proj = store.getProjections(db, [subject]).get(subject);
            return { pastes: await shapeMany(rows, v, { preview: true }), total, username: (proj && proj.username) || String(username) };
        },

        /** GET /api/pastes/:slug — counts a page view unless noView; burns a spent burn-after-read paste. */
        async get(v, slug, ctx = {}) {
            const p = visible(v, slug);
            if (!ctx.noView && !isOwner(v, p)) {
                if (p.burn_after_read) {
                    p.views = store.bumpViews(db, p.id);
                    if (p.views > 1) burn(p);
                } else {
                    countView(v, p, ctx);
                }
            }
            const liked = v.subject ? store.hasLiked(db, p.id, v.subject) : false;
            return { paste: { ...(await shapeOne(p, v)), liked } };
        },

        /** GET /p/:slug/raw — plain text, Media's raw rules (a burn paste survives exactly one read). */
        raw(v, slug, ctx = {}) {
            const p = store.getBySlug(db, String(slug));
            if (p && p.type === 'screenshot' && (p.visibility !== 'private' || canSeeHidden(v, p))) return { redirect: `/p/${encodeURIComponent(p.slug)}/screenshot` };
            if (!p || p.type !== 'paste' || (p.visibility === 'private' && !canSeeHidden(v, p))) fail(404, 'Not found');
            if (!isOwner(v, p)) {
                if (p.burn_after_read) {
                    if (p.views > 0) burn(p);
                    store.bumpViews(db, p.id);
                } else {
                    countView(v, p, ctx);
                }
            }
            return { content: String(p.content || '') };
        },

        /** GET /p/:slug/screenshot target (the stored Media URL). */
        screenshotUrl(v, slug) {
            const p = store.getBySlug(db, String(slug));
            if (!p || !p.screenshot_url || (p.visibility === 'private' && !canSeeHidden(v, p))) fail(404, 'Not found');
            return p.screenshot_url;
        },

        /** POST /api/pastes (text) */
        async createText(v, body = {}) {
            pasteRateCheck(v);
            const content = body.content;
            if (!content || typeof content !== 'string' || content.trim().length === 0) fail(400, 'Content is required');
            if (content.length > L.maxSizeKb * 1024) fail(400, `Paste too large (max ${L.maxSizeKb} KB)`);
            const metadata = serviceMetadata(v, body);
            const row = store.insertPaste(db, {
                slug: slugFor(v, body),
                owner_subject: v.subject || null,
                origin: v.origin === 'ai' ? 'ai' : 'user',
                type: 'paste',
                title: store.sanitizeTitle(body.title),
                content: content.trim(),
                language: store.detectLanguage(content, body.language),
                visibility: visibilityOf(body.visibility, !!v.subject),
                stream_ref: streamRefFor(v, body),
                metadata: metadata ? JSON.stringify(metadata) : null,
                burn_after_read: truthy(body.burn_after_read) ? 1 : 0,
                is_nsfw: truthy(body.is_nsfw) ? 1 : 0,
                ...aiFields(v, body),
            });
            return created(row, { paste: await shapeOne(row, v) });
        },

        /** POST /api/pastes/screenshot (and multipart POST /api/pastes) */
        async createScreenshot(v, body = {}, file, ctx = {}) {
            pasteRateCheck(v);
            if (!file || !file.buffer) fail(400, 'No screenshot uploaded');
            if (!IMAGE_MIME.test(file.mimetype || '')) fail(400, 'Only PNG, JPEG, WebP, or GIF images allowed');
            if (file.buffer.length > L.screenshotMaxSizeMb * 1024 * 1024) fail(400, `File too large (max ${L.screenshotMaxSizeMb} MB)`);
            if (!media) fail(503, 'Media service unavailable');
            const slug = slugFor(v, body);
            const extra = serviceMetadata(v, body);
            const bytes = stripImageMetadata(file.buffer, file.mimetype);
            let stored;
            try {
                stored = await media.upload({ buffer: bytes, filename: file.originalname || 'screenshot.png', mime: file.mimetype });
            } catch (err) {
                console.warn('[Pastes] screenshot upload failed:', err.message);
                fail(502, 'Media service unavailable');
            }
            const metadata = {
                ...(extra || {}),
                page_url: body.page_url || (extra && extra.page_url) || null,
                user_agent: body.user_agent || ctx.userAgent || null,
                original_name: file.originalname || null,
                size_bytes: bytes.length,
                mime_type: file.mimetype,
            };
            const row = store.insertPaste(db, {
                slug,
                owner_subject: v.subject || null,
                origin: v.origin === 'ai' ? 'ai' : 'user',
                type: 'screenshot',
                title: store.sanitizeTitle(body.title || 'Screenshot'),
                content: String(body.description || body.content || ''),
                language: 'text',
                visibility: visibilityOf(body.visibility, !!v.subject),
                screenshot_url: stored.url,
                media_ref: stored.media_ref,
                stream_ref: streamRefFor(v, body),
                metadata: JSON.stringify(metadata),
                burn_after_read: truthy(body.burn_after_read) ? 1 : 0,
                is_nsfw: truthy(body.is_nsfw) ? 1 : 0,
                ...aiFields(v, body),
            });
            return created(row, { paste: await shapeOne(row, v) });
        },

        /** PUT /api/pastes/:slug — owner (or staff) only. */
        async update(v, slug, body = {}) {
            needIdentity(v);
            const p = visible(v, slug);
            if (!isOwner(v, p) && !isStaff(v)) fail(403, 'Not authorized for this paste');
            const patch = {};
            if (body.title !== undefined) patch.title = store.sanitizeTitle(body.title);
            if (body.content !== undefined && p.type === 'paste') {
                const content = String(body.content);
                if (content.length > L.maxSizeKb * 1024) fail(400, 'Too large');
                patch.content = content;
                patch.language = store.detectLanguage(content, body.language);
            }
            if (body.visibility !== undefined) patch.visibility = visibilityOf(body.visibility, !!p.owner_subject);
            if (body.is_nsfw !== undefined) patch.is_nsfw = truthy(body.is_nsfw) ? 1 : 0;
            if (body.pinned !== undefined && isStaff(v)) patch.pinned = truthy(body.pinned) ? 1 : 0;
            if (!Object.keys(patch).length) fail(400, 'Nothing to update');
            const row = store.updatePaste(db, p.id, patch, v.subject || null);
            tell((pl) => pl.pasteChanged(row));
            return { paste: await shapeOne(row, v) };
        },

        /** DELETE /api/pastes/:slug — owner (or staff) only. */
        remove(v, slug) {
            needIdentity(v);
            const p = visible(v, slug);
            if (!isOwner(v, p) && !isStaff(v)) fail(403, 'Not authorized for this paste');
            store.softDelete(db, p.id);
            tell((pl) => pl.pasteGone(p.slug));
            return { success: true };
        },

        /** GET /api/pastes/:slug/versions — edit history, owner (or staff) only. */
        versions(v, slug) {
            needIdentity(v);
            const p = visible(v, slug);
            if (!isOwner(v, p) && !isStaff(v)) fail(403, 'Not authorized for this paste');
            const list = store.listVersions(db, p.id);
            return { revision: p.revision, versions: list.length ? list : [{ revision: p.revision, title: p.title, content: p.content, language: p.language, edited_by: p.owner_subject, created_at: p.updated_at }] };
        },

        /** POST /api/pastes/:slug/fork */
        async fork(v, slug) {
            const original = visible(v, slug);
            if (original.type !== 'paste') fail(400, 'Only text pastes can be forked');
            pasteRateCheck(v);
            const row = store.insertPaste(db, {
                slug: store.generateSlug(db),
                owner_subject: v.subject || null,
                origin: v.origin === 'ai' ? 'ai' : 'user',
                type: 'paste',
                title: store.sanitizeTitle(`Fork of ${original.title}`),
                content: original.content,
                language: original.language,
                visibility: 'public',
                forked_from: original.id,
            });
            return created(row, { paste: await shapeOne(row, v) });
        },

        /** POST /api/pastes/:slug/like — toggles; needs a person. */
        like(v, slug) {
            if (!v.subject) fail(401, 'Authentication required');
            const p = visible(v, slug);
            return store.toggleLike(db, p.id, v.subject);
        },

        /** POST /api/pastes/:slug/copy */
        copy(v, slug) {
            const p = visible(v, slug);
            return { copies: store.incrementCopies(db, p.id) };
        },

        /** GET /api/pastes/:slug/comments */
        async comments(v, slug, q = {}) {
            const p = visible(v, slug);
            const limit = Math.min(parseInt(q.limit || '50', 10) || 50, 100);
            const offset = Math.max(parseInt(q.offset || '0', 10) || 0, 0);
            const list = store.listComments(db, p.id, limit, offset);
            const subjects = [];
            for (const c of list) { subjects.push(c.author_subject); for (const r of c.replies) subjects.push(r.author_subject); }
            const projections = await projectionsFor(subjects);
            return { comments: list.map((c) => shapeComment(c, projections)), total: store.countComments(db, p.id) };
        },

        /** POST /api/pastes/:slug/comments — anonymous comments allowed (with a name). */
        async addComment(v, slug, body = {}, ctx = {}) {
            const p = visible(v, slug);
            const author = v.subject || null;
            if (!author && !L.commentAnonAllowed) fail(401, 'You must be logged in to comment');
            const message = String(body.message || '').trim();
            if (!message) fail(400, 'Comment cannot be empty');
            if (message.length > L.commentMaxLength) fail(400, `Comment must be under ${L.commentMaxLength} characters`);
            let anonName = null;
            if (!author) {
                anonName = String(body.anon_name || '').trim().substring(0, 32) || 'Anonymous';
                anonName = anonName.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'Anonymous';
            }
            const rateKey = author ? `s:${author}` : `ip:${ctx.ip || 'unknown'}`;
            if (limited(v)) commentRateCheck(rateKey, message);
            const parentId = body.parent_id ? parseInt(body.parent_id, 10) : null;
            if (parentId) {
                const parent = store.getComment(db, parentId);
                if (!parent || parent.paste_id !== p.id) fail(400, 'Invalid parent comment');
                if (parent.parent_id) fail(400, 'Cannot reply to a reply — reply to the original comment instead');
            }
            const c = store.createComment(db, { paste_id: p.id, author_subject: author, anon_name: anonName, parent_id: parentId, message });
            if (limited(v)) commentRecorded(rateKey, message);
            return { comment: shapeComment(c, await projectionsFor([author])) };
        },

        /** DELETE /api/pastes/:slug/comments/:id — the author, the paste's owner, or staff. */
        deleteComment(v, slug, commentId) {
            needIdentity(v);
            const p = visible(v, slug);
            const c = store.getComment(db, parseInt(commentId, 10));
            if (!c || c.paste_id !== p.id) fail(404, 'Comment not found');
            const isAuthor = !!(v.subject && c.author_subject && c.author_subject === v.subject);
            if (!isAuthor && !isOwner(v, p) && !isStaff(v)) fail(403, 'Not authorized to delete this comment');
            store.softDeleteComment(db, c.id);
            return { message: 'Comment deleted' };
        },

        /** GET /api/pastes/config */
        config(v) {
            return {
                maxSizeKb: L.maxSizeKb,
                screenshotMaxSizeMb: L.screenshotMaxSizeMb,
                cooldownSeconds: L.cooldownSeconds,
                maxPerUserPerDay: L.maxPerUserPerDay,
                todayCount: v.subject ? store.countOwnerSince(db, v.subject, '-1 day') : 0,
            };
        },

        // ── staff (api.js has already checked the viewer is staff) ──
        stats() { return { stats: store.stats(db) }; },

        forks(q = {}) {
            const limit = intIn(q.limit, 100, 1, 500);
            const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
            const { forks, total } = store.listForks(db, limit, offset);
            return { forks: forks.map((f) => ({ ...f, user_id: f.owner_subject || null })), total, limit, offset };
        },

        deleteForks() { return { success: true, deleted: store.deleteAllForks(db) }; },

        bulk(body = {}) {
            const { slugs, action } = body;
            if (!Array.isArray(slugs) || !slugs.length) fail(400, 'No slugs provided');
            if (!['delete', 'public', 'unlisted', 'private'].includes(action)) fail(400, 'Invalid action');
            let done = 0, skipped = 0;
            db.transaction(() => {
                for (const slug of slugs.slice(0, 500)) {
                    const p = store.getBySlug(db, String(slug));
                    if (!p) { skipped++; continue; }
                    if (action === 'delete') store.softDelete(db, p.id);
                    else store.setVisibility(db, p.id, action);
                    if (action !== 'public') tell((pl) => pl.pasteGone(p.slug));
                    done++;
                }
            })();
            return { done, skipped };
        },

        /** POST /api/pastes/:slug/censor — replace a screenshot's image (slug or numeric id). */
        async censor(v, slugOrId, file) {
            let p = store.getBySlug(db, String(slugOrId));
            if (!p && /^\d+$/.test(String(slugOrId))) p = store.getById(db, parseInt(slugOrId, 10));
            if (!p) fail(404, 'Paste not found');
            if (p.type !== 'screenshot' || !p.screenshot_url) fail(400, 'Not a screenshot paste');
            if (!file || !file.buffer) fail(400, 'Censored image is required');
            if (!/^image\/(png|jpeg|webp)$/.test(file.mimetype || '')) fail(400, 'Only PNG, JPEG, or WebP images allowed');
            if (!media) fail(503, 'Media service unavailable');
            let stored;
            try {
                stored = await media.upload({ buffer: stripImageMetadata(file.buffer, file.mimetype), filename: file.originalname || 'censored.png', mime: file.mimetype });
            } catch (err) {
                console.warn('[Pastes] censor upload failed:', err.message);
                fail(502, 'Media service unavailable');
            }
            const row = store.setScreenshot(db, p.id, stored.url, stored.media_ref);
            return { paste: await shapeOne(row, v) };
        },

        /** POST /api/pastes/:slug/ai — the AI pass writes its results back. */
        async setAi(v, slug, body = {}) {
            const p = store.getBySlug(db, String(slug));
            if (!p) fail(404, 'Paste not found');
            const summary = body.ai_summary == null ? null : String(body.ai_summary).slice(0, 2000);
            const tags = body.ai_tags == null ? null : (typeof body.ai_tags === 'string' ? body.ai_tags : JSON.stringify(body.ai_tags)).slice(0, 2000);
            const row = store.setAi(db, p.id, summary, tags);
            return { ok: true, paste: await shapeOne(row, v) };
        },
    };
}

module.exports = { createPasteService, PasteError, DEFAULT_LIMITS, AI_DISPLAY_NAME };
