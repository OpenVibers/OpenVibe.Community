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
 *   POST /s/:space/t/:slug/reply | /vote | /state | /delete   no-JS forms
 *
 * Form posts carry the ov_token cookie (SameSite=Lax, so other sites cannot post as the
 * visitor); an Origin header from somewhere else is refused as well.
 */
const express = require('express');
const seo = require('../seo');
const pages = require('../render/pages');
const forumPages = require('../render/forum');
const { ApiError } = require('../http/v1');

function createForumRoutes({ forum, viewers, config }) {
    const router = express.Router();
    const withViewer = viewers.middleware({ services: false });
    const form = express.urlencoded({ extended: false, limit: '256kb' });
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);
    const login = (res, next) => res.redirect(303, `/auth/login?next=${encodeURIComponent(next)}`);
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    /** Render an ApiError as a page: sign-in for 401, the error page for the rest. */
    function failPage(req, res, err, next) {
        if (!(err instanceof ApiError)) return next(err);
        if (err.status === 401) return login(res, req.originalUrl.replace(/\/(reply|vote|state|delete)$/, ''));
        const titles = { 404: 'Not found', 403: 'Not allowed', 429: 'Slow down' };
        return html(res, pages.errorPage({ status: err.status, title: titles[err.status] || 'That did not work', message: err.message }), err.status);
    }

    function sameOrigin(req, res, next) {
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
        next();
    }

    router.get('/s', withViewer, wrap(async (req, res, next) => {
        try { html(res, forumPages.spacesPage({ ...forum.listSpaces(req.viewer), user: req.user })); } catch (err) { failPage(req, res, err, next); }
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
            const out = await forum.listThreads(req.viewer, req.params.space, { sort: req.query.sort, page: req.query.page });
            if (out.page > out.pages) throw new ApiError(404, 'page.not_found', 'There is no page with that number.');
            html(res, forumPages.spacePage({ ...out, user: req.user }));
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.get('/s/:space/new', withViewer, (req, res, next) => {
        try {
            const { space } = forum.space(req.viewer, req.params.space);
            html(res, forumPages.newThreadPage({ space, user: req.user }));
        } catch (err) { failPage(req, res, err, next); }
    });

    router.post('/s/:space/new', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const values = { title: String((req.body || {}).title || '').slice(0, 200), body: String((req.body || {}).body || '').slice(0, 40_000) };
        try {
            const out = await forum.createThread(req.viewer, req.params.space, values);
            seo.resetCaches();
            res.redirect(303, out.thread.url);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 404) return failPage(req, res, err, next);
            try {
                const { space } = forum.space(req.viewer, req.params.space);
                html(res, forumPages.newThreadPage({ space, user: req.user, values, error: err.message }), err.status);
            } catch (e) { failPage(req, res, e, next); }
        }
    }));

    async function renderThread(req, res, { status = 200, error = null, draft = '' } = {}) {
        const out = await forum.getThread(req.viewer, req.params.space, req.params.slug, { page: req.query.page });
        if (out.page > out.pages) throw new ApiError(404, 'page.not_found', 'There is no page with that number.');
        html(res, forumPages.threadPage({ ...out, perPage: out.per_page, user: req.user, error, draft }), status);
    }

    router.get('/s/:space/t/:slug', withViewer, wrap(async (req, res, next) => {
        try { await renderThread(req, res); } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/s/:space/t/:slug/reply', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const draft = String((req.body || {}).body || '').slice(0, 40_000);
        try {
            const out = await forum.reply(req.viewer, req.params.space, req.params.slug, { body: draft });
            res.redirect(303, out.url);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 404) return failPage(req, res, err, next);
            try {
                // The reply form lives on the thread's last page; show it there with the error and the draft.
                const probe = await forum.getThread(req.viewer, req.params.space, req.params.slug, {});
                req.query.page = String(probe.pages);
                await renderThread(req, res, { status: err.status, error: err.message, draft });
            } catch (e) { failPage(req, res, e, next); }
        }
    }));

    const back = (req) => `/s/${encodeURIComponent(req.params.space)}/t/${encodeURIComponent(req.params.slug)}`;

    router.post('/s/:space/t/:slug/vote', withViewer, sameOrigin, form, (req, res, next) => {
        try {
            forum.voteThread(req.viewer, req.params.space, req.params.slug, { value: (req.body || {}).value });
            res.redirect(303, back(req));
        } catch (err) { failPage(req, res, err, next); }
    });

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
