'use strict';

/**
 * A comment thread's own page (render/comments.js has the markup, service.js the rules):
 *
 *   GET  /c/:accessId     the thread, newest first (?after=<last comment id> for older ones)
 *   POST /c/:accessId     comment (signed in; the no-JS form)
 *
 * Only the unguessable access id (cth_…) opens a page — the one Community hands out on resolve and
 * owner products link to — so pages cannot be walked either. Hidden threads are 404. Form posts
 * carry the ov_token cookie (SameSite=Lax) and an Origin from another site is refused, as in the
 * forum.
 */
const express = require('express');
const pages = require('../render/pages');
const { threadPage } = require('../render/comments');
const { ApiError } = require('../http/v1');

const ACCESS_ID_RE = /^cth_[A-Za-z0-9_-]{22}$/;

function createCommentPages({ comments, viewers, config }) {
    const router = express.Router();
    const withViewer = viewers.middleware({ services: false });
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

    function failPage(req, res, err, next) {
        if (!(err instanceof ApiError)) return next(err);
        if (err.status === 401) return res.redirect(303, `/auth/login?next=${encodeURIComponent(`/c/${req.params.accessId}`)}`);
        const titles = { 404: 'Not found', 403: 'Not allowed', 429: 'Slow down' };
        return html(res, pages.errorPage({ status: err.status, title: titles[err.status] || 'That did not work', message: err.status === 404 ? 'There is no comment thread at that address.' : err.message }), err.status);
    }

    const notFound = () => new ApiError(404, 'thread.not_found', 'Comment thread not found');

    async function render(req, res, { status = 200, error = null, draft = '' } = {}) {
        const after = /^\d{1,15}$/.test(String(req.query.after || '')) ? String(req.query.after) : null;
        const page = await comments.get(req.viewer, req.params.accessId, { sort: 'new', after, limit: 30 });
        html(res, threadPage({ accessId: req.params.accessId, page, user: req.user, after, error, draft }), status);
    }

    router.get('/c/:accessId', withViewer, wrap(async (req, res, next) => {
        try {
            if (!ACCESS_ID_RE.test(req.params.accessId)) throw notFound();
            await render(req, res);
        } catch (err) { failPage(req, res, err, next); }
    }));

    router.post('/c/:accessId', withViewer, form, wrap(async (req, res, next) => {
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
        const draft = String((req.body || {}).message || '').slice(0, 5000);
        try {
            if (!ACCESS_ID_RE.test(req.params.accessId)) throw notFound();
            // Signed-in people only on this page, whatever the thread allows through the API.
            if (!req.viewer || !req.viewer.subject) throw new ApiError(401, 'auth.required', 'Sign in to comment');
            const out = await comments.add(req.viewer, req.params.accessId, { message: draft });
            res.redirect(303, `/c/${req.params.accessId}#comment-${out.comment.id}`);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401 || err.status === 404) return failPage(req, res, err, next);
            try { await render(req, res, { status: err.status, error: err.message, draft }); } catch (e) { failPage(req, res, e, next); }
        }
    }));

    return router;
}

module.exports = { createCommentPages };
