'use strict';

/**
 * Server-rendered forum routes (the pages are in render/forum.js, the rules in service.js):
 *
 *   GET  /s                              spaces
 *   GET  /s/feed.xml                     RSS: latest threads in public spaces
 *   GET  /s/:space                       threads (?sort=hot|new|top&page=)
 *   GET  /s/:space/feed.xml              RSS: latest threads of one public space
 *   GET  /s/:space/new   POST /s/:space/new               start a thread
 *   GET  /s/:space/t/:slug                                a thread (?page=)
 *   POST /s/:space/t/:slug/reply | /vote | /state | /delete | /members-only   no-JS forms
 *
 * A members-only (OpenVibe.VIP) space or thread the viewer may not use renders a teaser with the
 * creator's join link (403), never its posts.
 *
 * Form posts carry the ov_token cookie (SameSite=Lax, so other sites cannot post as the
 * visitor); an Origin header from somewhere else is refused as well.
 */
const express = require('express');
const multer = require('multer');
const seo = require('../seo');
const pages = require('../render/pages');
const forumPages = require('../render/forum');
const boardPages = require('../render/board');
const { ApiError } = require('../http/v1');

function createForumRoutes({ forum, viewers, config }) {
    const router = express.Router();
    const withViewer = viewers.middleware({ services: false });
    const form = express.urlencoded({ extended: false, limit: '256kb' });
    // New threads and replies may carry up to 4 images (multipart `attachments`); a urlencoded form passes through.
    const imageParser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 4, fields: 20, fieldSize: 64 * 1024 } }).array('attachments', 4);
    const withImages = (req, res, next) => imageParser(req, res, (err) => {
        if (err) req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Images are limited to 8 MB' : (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') ? 'At most 4 images per post' : 'The images could not be read';
        next();
    });
    /** Store the form's images in Media first. → their media ids (the post then names them) */
    async function uploadImages(req) {
        if (req.uploadError) throw new ApiError(400, 'attachments.invalid', req.uploadError);
        const ids = [];
        for (const f of req.files || []) {
            if (!f || !f.size) continue;
            ids.push((await forum.uploadAttachment(req.viewer, req.params.space, f)).attachment.media_id);
        }
        return ids;
    }
    const worthUploading = (title, body) => (title == null || String(title).trim().length >= 3) && String(body || '').trim().length > 0;
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);
    const login = (res, next) => res.redirect(303, `/auth/login?next=${encodeURIComponent(next)}`);
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    /** Render an ApiError as a page: sign-in for 401, the error page for the rest. */
    function failPage(req, res, err, next) {
        if (!(err instanceof ApiError)) return next(err);
        if (err.status === 401) return login(res, req.originalUrl.replace(/\/(reply|vote|state|delete|members-only|react|crosspost|settings|status|category)$/, ''));
        if (err.code === 'vip.members_only' && err.extra) {
            return html(res, forumPages.membersOnlyPage({ ...err.extra, user: req.user, next: req.originalUrl.replace(/\/(reply|vote|state|delete|members-only|new)$/, '') }), 403);
        }
        const titles = { 404: 'Not found', 403: 'Not allowed', 429: 'Slow down' };
        return html(res, pages.errorPage({ status: err.status, title: titles[err.status] || 'That did not work', message: err.message }), err.status);
    }

    function sameOrigin(req, res, next) {
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
        next();
    }

    // The board index (vBulletin/SMF style): every space, grouped, with topics, posts and the last post.
    router.get('/s', withViewer, wrap(async (req, res, next) => {
        try { html(res, boardPages.boardIndexPage({ ...(await forum.listSpaces(req.viewer)), user: req.user, canModerate: forum.isModerator(req.viewer) })); } catch (err) { failPage(req, res, err, next); }
    }));

    // Moderators: a new space, either style.
    router.get('/s/new-space', withViewer, wrap(async (req, res, next) => {
        try {
            if (!req.user) return login(res, '/s/new-space');
            if (!forum.isModerator(req.viewer)) throw new ApiError(403, 'capability.denied', 'Only moderators create spaces');
            html(res, boardPages.newSpacePage({ groups: forum.groups() }));
        } catch (err) { failPage(req, res, err, next); }
    }));
    router.post('/s/new-space', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const b = req.body || {};
        const values = { name: b.name, slug: b.slug, description: b.description, style: b.style === 'feed' ? 'feed' : 'forum', votes: b.votes === '1', reactions: b.reactions === '1', group: b.group || null };
        try {
            const out = await forum.createSpace(req.viewer, values);
            seo.resetCaches();
            res.redirect(303, `/s/${out.space.slug}`);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 403) return failPage(req, res, err, next);
            html(res, boardPages.newSpacePage({ groups: forum.groups(), error: err.message, values }), err.status);
        }
    }));

    // "Discuss in a space" from a paste: pick the space, then its new-topic form with the paste attached.
    router.get('/s/discuss', withViewer, wrap(async (req, res, next) => {
        try {
            const paste = String(req.query.paste || '').slice(0, 80);
            const { groups } = await forum.listSpaces(req.viewer);
            html(res, boardPages.discussPage({ groups, paste, user: req.user }));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.get('/s/feed.xml', (_req, res) => {
        res.type('application/rss+xml').set('Cache-Control', 'public, max-age=300').send(seo.threadFeed({ threads: forum.recentPublic({ limit: 30 }) }));
    });

    router.get('/s/:space/feed.xml', (req, res) => {
        const space = forum.publicSpaces().find((s) => s.slug === req.params.space);
        if (!space) return res.status(404).type('text/plain').send('Not found');
        res.type('application/rss+xml').set('Cache-Control', 'public, max-age=300').send(seo.threadFeed({ space, threads: forum.recentPublic({ limit: 30, space: space.slug }) }));
    });

    router.get('/s/:space', withViewer, wrap(async (req, res, next) => {
        try {
            const out = await forum.listThreads(req.viewer, req.params.space, { sort: req.query.sort, page: req.query.page, category: req.query.category, status: req.query.status });
            if (out.page > out.pages) throw new ApiError(404, 'page.not_found', 'There is no page with that number.');
            if (out.space.style === 'forum') return html(res, boardPages.forumSpacePage({ ...out, user: req.user }));
            html(res, forumPages.spacePage({ ...out, user: req.user, footer: out.viewer.can_moderate ? boardPages.settingsForm(out.space, out.groups) : '' }));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.get('/s/:space/new', withViewer, wrap(async (req, res, next) => {
        try {
            // A members-only space: the teaser, not the form, for someone who may not post there.
            const probe = await forum.listThreads(req.viewer, req.params.space, { limit: 1 });
            if (!probe.viewer.can_start) throw new ApiError(403, 'space.staff_threads', 'Roadmap items are added by staff. Reply to one, or suggest something in Feedback');
            const { space } = await forum.space(req.viewer, req.params.space);
            const paste = /^[A-Za-z0-9_-]{3,80}$/.test(String(req.query.paste || '')) ? String(req.query.paste) : '';
            html(res, forumPages.newThreadPage({ space, user: req.user, categories: probe.categories, attachments: forum.attachmentsEnabled(), values: paste ? { pastes: paste, title: forum.pasteTitle(paste) || '' } : {} }));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/new', withViewer, sameOrigin, withImages, form, wrap(async (req, res, next) => {
        const values = { title: String((req.body || {}).title || '').slice(0, 200), body: String((req.body || {}).body || '').slice(0, 40_000) };
        if ((req.body || {}).members_only === '1') values.members_only = true;
        if ((req.body || {}).category) values.category = String(req.body.category).slice(0, 40);
        if ((req.body || {}).pastes) values.pastes = String(req.body.pastes).slice(0, 400);
        try {
            // Images go to Media only when the rest can be saved (no strays from an empty form).
            if (worthUploading(values.title, values.body)) { const ids = await uploadImages(req); if (ids.length) values.attachments = ids; }
            const out = await forum.createThread(req.viewer, req.params.space, values);
            seo.resetCaches();
            res.redirect(303, out.thread.url);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 404 || err.code === 'vip.members_only') return failPage(req, res, err, next);
            try {
                const { space } = await forum.space(req.viewer, req.params.space);
                const { categories } = forum.categories(req.viewer, req.params.space);
                html(res, forumPages.newThreadPage({ space, user: req.user, values, error: err.message, categories, attachments: forum.attachmentsEnabled() }), err.status);
            } catch (e) { failPage(req, res, e, next); }
        }
    }));

    async function renderThread(req, res, { status = 200, error = null, draft = '' } = {}) {
        const out = await forum.getThread(req.viewer, req.params.space, req.params.slug, { page: req.query.page });
        if (out.page > out.pages) throw new ApiError(404, 'page.not_found', 'There is no page with that number.');
        if (status === 200 && forum.recordView(out.thread.id, req.user && req.user.subject_id ? `s:${req.user.subject_id}` : `ip:${req.ip}`)) out.thread.views += 1;
        // Quote (no JS): ?quote=<post id> fills the reply box with the quoted post.
        if (!draft && /^\d{1,15}$/.test(String(req.query.quote || '')) && out.viewer.can_reply) {
            try { draft = (await forum.quote(req.viewer, req.query.quote)).markdown; } catch { /* a post that is gone: an empty box */ }
        }
        const view = { ...out, perPage: out.per_page, user: req.user, error, draft, attachmentsEnabled: forum.attachmentsEnabled() };
        html(res, out.space.style === 'forum' ? boardPages.forumTopicPage(view) : forumPages.threadPage(view), status);
    }

    router.get('/s/:space/t/:slug', withViewer, wrap(async (req, res, next) => {
        try { await renderThread(req, res); } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/t/:slug/reply', withViewer, sameOrigin, withImages, form, wrap(async (req, res, next) => {
        const draft = String((req.body || {}).body || '').slice(0, 40_000);
        try {
            const attachments = worthUploading(null, draft) ? await uploadImages(req) : [];
            const pastes = String((req.body || {}).pastes || '').slice(0, 400) || undefined;
            const out = await forum.reply(req.viewer, req.params.space, req.params.slug, { body: draft, attachments: attachments.length ? attachments : undefined, pastes });
            res.redirect(303, out.url);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 404 || err.code === 'vip.members_only') return failPage(req, res, err, next);
            try {
                // The reply form lives on the thread's last page; show it there with the error and the draft.
                const probe = await forum.getThread(req.viewer, req.params.space, req.params.slug, {});
                req.query.page = String(probe.pages);
                await renderThread(req, res, { status: err.status, error: err.message, draft });
            } catch (e) { failPage(req, res, e, next); }
        }
    }));

    const back = (req) => `/s/${encodeURIComponent(req.params.space)}/t/${encodeURIComponent(req.params.slug)}`;

    router.post('/s/:space/t/:slug/vote', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        try {
            await forum.voteThread(req.viewer, req.params.space, req.params.slug, { value: (req.body || {}).value });
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    }));

    // Members-only on/off (no JS): on gates the thread to its author's VIP members.
    router.post('/s/:space/t/:slug/members-only', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        try {
            await forum.setThreadMembersOnly(req.viewer, req.params.space, req.params.slug, { members_only: (req.body || {}).on === '1' ? true : null });
            seo.resetCaches();
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/t/:slug/state', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const b = req.body || {};
        const flags = {};
        if (b.pinned !== undefined) flags.pinned = b.pinned === '1';
        if (b.locked !== undefined) flags.locked = b.locked === '1';
        try {
            await forum.moderateThread(req.viewer, req.params.space, req.params.slug, flags);
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    }));

    // Rate a post (no JS): the rating's button in the post's form; back to the post.
    router.post('/s/:space/t/:slug/react', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const b = req.body || {};
        try {
            await forum.react(req.viewer, String(b.post || ''), { reaction: String(b.reaction || '') || null });
            const page = Math.max(parseInt(b.page, 10) || 1, 1);
            res.redirect(303, `${back(req)}${page > 1 ? `?page=${page}` : ''}#post-${encodeURIComponent(String(b.post || ''))}`);
        } catch (err) { failPage(req, res, err, next); }
    }));

    // Crosspost to another space (no JS).
    router.post('/s/:space/t/:slug/crosspost', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        try {
            const out = await forum.crosspost(req.viewer, req.params.space, req.params.slug, { to: String((req.body || {}).to || '') });
            seo.resetCaches();
            res.redirect(303, out.thread.url);
        } catch (err) { failPage(req, res, err, next); }
    }));

    // Moderators: a space's settings (no JS).
    router.post('/s/:space/settings', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const b = req.body || {};
        try {
            await forum.updateSpaceSettings(req.viewer, req.params.space, { name: b.name, description: b.description, style: b.style, votes: b.votes === '1', reactions: b.reactions === '1', group: b.group || null });
            seo.resetCaches();
            res.redirect(303, `/s/${encodeURIComponent(req.params.space)}`);
        } catch (err) { failPage(req, res, err, next); }
    }));

    // Status (moderators) and category (the author or moderators), no JS.
    router.post('/s/:space/t/:slug/status', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        try {
            await forum.setThreadStatus(req.viewer, req.params.space, req.params.slug, { status: String((req.body || {}).status || '') });
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/t/:slug/category', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        try {
            await forum.setThreadCategory(req.viewer, req.params.space, req.params.slug, { category: String((req.body || {}).category || '') || null });
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/t/:slug/delete', withViewer, sameOrigin, form, (req, res, next) => {
        try {
            forum.deleteThread(req.viewer, req.params.space, req.params.slug);
            seo.resetCaches();
            res.redirect(303, `/s/${encodeURIComponent(req.params.space)}`);
        } catch (err) { failPage(req, res, err, next); }
    });

    return router;
}

module.exports = { createForumRoutes };
