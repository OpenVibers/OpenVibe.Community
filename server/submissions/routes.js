'use strict';

/**
 * Submission pages (render/submissions.js has the markup, service.js the rules):
 *
 *   GET  /submissions                   accepted ones, ?kind=, ?mine=1 (your own), ?after=; the submit form when signed in
 *   POST /submissions                   submit (signed in; the no-JS form)
 *   GET  /submissions/review            the moderators' queue (pending), ?after=
 *   GET  /submissions/:slug             one submission (accepted: anyone; else its author and moderators)
 *   POST /submissions/:slug/withdraw    the author
 *   POST /submissions/:slug/review      moderators: decision=accept|reject, note
 *
 * Form posts carry the ov_token cookie (SameSite=Lax) and an Origin from another site is refused,
 * as on other no-JS forms.
 */
const express = require('express');
const pages = require('../render/pages');
const { submissionsPage, submissionPage, reviewQueuePage } = require('../render/submissions');
const { ApiError } = require('../http/v1');
const cache = require('openvibe-shared/cache-policy');

function createSubmissionPages({ submissions, viewers, config }) {
    const router = express.Router();
    const withViewer = viewers.middleware({ services: false });
    const form = express.urlencoded({ extended: false, limit: '64kb' });
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', cache.htmlHeaders({ private: true })).send(body);
    const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
    const login = (res, next) => res.redirect(303, `/auth/login?next=${encodeURIComponent(next)}`);

    function failPage(req, res, err, next, back) {
        if (!(err instanceof ApiError)) return next(err);
        if (err.status === 401) return login(res, back || req.originalUrl);
        const titles = { 404: 'Not found', 403: 'Not allowed', 409: 'Already decided', 429: 'Slow down' };
        return html(res, pages.errorPage({ status: err.status, title: titles[err.status] || 'That did not work', message: err.status === 404 ? 'There is no submission at that address.' : err.message }), err.status);
    }

    function sameOrigin(req, res, next) {
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
        next();
    }

    async function renderList(req, res, { status = 200, values = {}, error = null } = {}) {
        const kind = submissions.KINDS.includes(req.query.kind) ? req.query.kind : '';
        const mine = !!req.user && req.query.mine === '1';
        const after = req.query.after ? String(req.query.after) : null;
        // The list page is the accepted ones for everybody, moderators too (they have the queue).
        const out = await submissions.list(req.viewer, { kind, mine: mine ? '1' : '', status: mine ? '' : 'accepted', after });
        html(res, submissionsPage({ items: out.submissions, kind, mine, after, nextCursor: out.next_cursor, user: req.user, moderator: submissions.moderates(req.viewer), values, error }), status);
    }

    router.get('/submissions', withViewer, wrap(async (req, res, next) => {
        try { await renderList(req, res); }
        catch (err) {
            if (err instanceof ApiError && err.code === 'request.invalid_cursor') return res.redirect(302, '/submissions');
            failPage(req, res, err, next);
        }
    }));

    router.post('/submissions', withViewer, sameOrigin, form, wrap(async (req, res, next) => {
        const b = req.body || {};
        const values = { kind: String(b.kind || ''), title: String(b.title || '').slice(0, 300), url: String(b.url || '').slice(0, 2100), body: String(b.body || '').slice(0, 12000) };
        try {
            // Signed-in people only (a browser's own JWT); the same rules as the API.
            if (!req.viewer || !req.viewer.subject) throw new ApiError(401, 'auth.required', 'Sign in to submit');
            const out = await submissions.create(req.viewer, values);
            res.redirect(303, out.submission.page_url);
        } catch (err) {
            if (!(err instanceof ApiError) || err.status === 401) return failPage(req, res, err, next, '/submissions');
            try { await renderList(req, res, { status: err.status, values, error: err.message }); } catch (e) { failPage(req, res, e, next); }
        }
    }));

    router.get('/submissions/review', withViewer, wrap(async (req, res, next) => {
        try {
            if (!req.viewer || !req.viewer.subject) throw new ApiError(401, 'auth.required', 'Sign in to review');
            if (!submissions.moderates(req.viewer)) throw new ApiError(403, 'submission.moderators_only', 'Only moderators review submissions.');
            const after = req.query.after ? String(req.query.after) : null;
            const out = await submissions.list(req.viewer, { status: 'pending', after });
            html(res, reviewQueuePage({ items: out.submissions, after, nextCursor: out.next_cursor }));
        } catch (err) {
            if (err instanceof ApiError && err.code === 'request.invalid_cursor') return res.redirect(302, '/submissions/review');
            failPage(req, res, err, next);
        }
    }));

    router.get('/submissions/:slug', withViewer, wrap(async (req, res, next) => {
        try { html(res, submissionPage({ submission: (await submissions.get(req.viewer, req.params.slug)).submission, user: req.user })); }
        catch (err) { failPage(req, res, err, next); }
    }));

    // Withdraw and review: back to the submission's page (303), or the page with the reason.
    for (const action of ['withdraw', 'review']) {
        router.post(`/submissions/:slug/${action}`, withViewer, sameOrigin, form, wrap(async (req, res, next) => {
            const page = `/submissions/${encodeURIComponent(req.params.slug)}`;
            try {
                if (!req.viewer || !req.viewer.subject) throw new ApiError(401, 'auth.required', 'Sign in first');
                const b = req.body || {};
                if (action === 'withdraw') await submissions.withdraw(req.viewer, req.params.slug);
                else await submissions.review(req.viewer, req.params.slug, { decision: String(b.decision || ''), note: String(b.note || '').slice(0, 1200) });
                res.redirect(303, page);
            } catch (err) {
                if (!(err instanceof ApiError) || err.status === 401 || err.status === 404) return failPage(req, res, err, next, page);
                try { html(res, submissionPage({ submission: (await submissions.get(req.viewer, req.params.slug)).submission, user: req.user, error: err.message }), err.status); }
                catch (e) { failPage(req, res, e, next); }
            }
        }));
    }

    return router;
}

module.exports = { createSubmissionPages };
