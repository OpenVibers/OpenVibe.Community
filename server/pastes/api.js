'use strict';

/**
 * /api/pastes/* — Community's native paste API (PASTES_AUTHORITY=community).
 *
 * Same paths, bodies, status codes and response shapes the browser clients already use against
 * OpenVibe.Live's proxy (which fronted OpenVibe.Media); the rules live in service.js.
 *
 *   GET    /                         list (?limit&offset&type&search&sort&origin&username&include_unlisted)
 *                                    ?needs_ai=1 — AI work queue, community.paste.moderate only
 *   POST   /                         create (JSON text paste, or multipart with a `screenshot` file)
 *   GET    /config                   limits
 *   POST   /screenshot               create an image paste (multipart `screenshot`)
 *   GET    /by-user/:username        someone's pastes (their own hidden ones for them)
 *   GET    /:slug                    one paste (counts a view unless ?no_view=1)
 *   PUT    /:slug  DELETE /:slug     owner or staff
 *   GET    /:slug/raw                → /p/:slug/raw
 *   GET    /:slug/versions           edit history (owner or staff)
 *   POST   /:slug/fork|like|copy
 *   GET    /:slug/comments  POST /:slug/comments  DELETE /:slug/comments/:id
 *   Staff: GET /admin/stats, GET|DELETE /admin/forks, POST /bulk, POST /:slug/censor, POST /:slug/ai
 *
 * Callers (identity/viewer.js): browsers with the Network user JWT, anonymous browsers, and
 * first-party services with a Network service token. A service must hold the capability of the
 * route it calls: community.paste.create (create), community.paste.write (everything done as the
 * acting subject), community.paste.moderate (staff routes, needs_ai, X-OV-Staff). Anonymous writes
 * are limited to 20 per 10 minutes per address.
 */
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { PasteError } = require('./service');
const { hasCap } = require('../identity/viewer');

const PASTE_CAPS = ['community.paste.create', 'community.paste.write', 'community.paste.moderate'];

function createPastesApi({ service, viewers, anonWriteLimiter: sharedLimiter = null }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());

    const json = express.json({ limit: '1mb' });
    const jsonErrors = (err, _req, res, next) => (err ? res.status(400).json({ error: 'Malformed JSON body' }) : next());
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024, files: 1, fields: 30 } }).single('screenshot');
    const withFile = (req, res, next) => upload(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : (err.message || 'Upload failed') }) : next()));
    const body = (req, res, next) => (req.is('multipart/form-data') ? withFile(req, res, next) : json(req, res, (err) => jsonErrors(err, req, res, next)));

    // Anonymous posts are allowed; people acting as themselves and services have their own limits.
    const anonWriteLimiter = sharedLimiter || rateLimit({
        windowMs: 10 * 60 * 1000,
        max: 20,
        standardHeaders: true,
        legacyHeaders: false,
        skip: (req) => !req.viewer || req.viewer.kind !== 'anonymous',
        message: { error: 'Too many anonymous posts — sign in or try again later' },
    });

    /** A service must hold the route's capability; browsers are judged by identity instead. */
    const guard = (cap) => (req, res, next) => {
        const v = req.viewer;
        if (v.kind !== 'service') return next();
        const c = contracts.capabilities.check(v.claims, cap);
        if (c.allowed) return next();
        return contracts.http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
    /** Reads: any community.paste.* grant (a service token with none of them isn't meant for us). */
    const anyCap = (req, res, next) => {
        const v = req.viewer;
        if (v.kind !== 'service' || PASTE_CAPS.some((c) => hasCap(v, c))) return next();
        return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: 'no community.paste capability granted', ctx: req.ov });
    };
    /** Staff-only routes: a service with community.paste.moderate, or an admin/global_mod browser. */
    const staffOnly = (req, res, next) => {
        const v = req.viewer;
        if (v.kind === 'service') return guard('community.paste.moderate')(req, res, next);
        if (v.kind === 'user' && v.staff) return next();
        if (v.kind === 'anonymous') return res.status(401).json({ error: 'Authentication required' });
        return res.status(403).json({ error: 'Admin access required' });
    };
    /** The AI pass (needs_ai queue, /:slug/ai) is for services only, never a browser — not even staff. */
    const serviceModerator = (req, res, next) => {
        if (req.viewer.kind !== 'service') return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: 'service token with community.paste.moderate required', ctx: req.ov });
        return guard('community.paste.moderate')(req, res, next);
    };

    const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') || '' });
    const run = (fn, status = 200) => async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            res.status(status).json(out);
        } catch (err) {
            if (err instanceof PasteError) return res.status(err.status).json(err.body);
            console.error('[Pastes]', err && err.stack ? err.stack : err);
            if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
        }
    };
    const slug = (req) => req.params.slug;

    // ── collection + literal paths (before /:slug) ───────────
    router.get('/', anyCap, (req, res, next) => (req.query.needs_ai && req.viewer.kind !== 'service'
        ? contracts.http.sendProblem(res, 403, 'capability.denied', { detail: 'needs_ai is for services holding community.paste.moderate', ctx: req.ov })
        : next()), run((req) => service.list(req.viewer, req.query)));

    router.post('/', guard('community.paste.create'), anonWriteLimiter, body,
        run((req) => (req.file ? service.createScreenshot(req.viewer, req.body || {}, req.file, ctx(req)) : service.createText(req.viewer, req.body || {})), 201));

    router.get('/config', anyCap, run((req) => service.config(req.viewer)));

    router.get('/admin/stats', staffOnly, run(() => service.stats()));
    router.get('/admin/forks', staffOnly, run((req) => service.forks(req.query)));
    router.delete('/admin/forks', staffOnly, run(() => service.deleteForks()));
    router.post('/bulk', staffOnly, json, jsonErrors, run((req) => service.bulk(req.body || {})));

    router.post('/screenshot', guard('community.paste.create'), anonWriteLimiter, withFile,
        run((req) => service.createScreenshot(req.viewer, req.body || {}, req.file, ctx(req)), 201));

    router.get('/by-user/:username', anyCap, run((req) => service.byUser(req.viewer, req.params.username, req.query)));

    // ── one paste ────────────────────────────────────────────
    router.get('/:slug', anyCap, run((req) => service.get(req.viewer, slug(req), { ...ctx(req), noView: String(req.query.no_view || '') === '1' })));
    router.put('/:slug', guard('community.paste.write'), json, jsonErrors, run((req) => service.update(req.viewer, slug(req), req.body || {})));
    router.delete('/:slug', guard('community.paste.write'), run((req) => service.remove(req.viewer, slug(req))));

    router.post('/:slug/censor', staffOnly, withFile, run((req) => service.censor(req.viewer, slug(req), req.file)));
    router.post('/:slug/ai', serviceModerator, json, jsonErrors, run((req) => service.setAi(req.viewer, slug(req), req.body || {})));

    router.get('/:slug/raw', (req, res) => res.redirect(302, `/p/${encodeURIComponent(slug(req))}/raw`));
    router.get('/:slug/versions', anyCap, run((req) => service.versions(req.viewer, slug(req))));

    router.post('/:slug/fork', guard('community.paste.write'), anonWriteLimiter, json, jsonErrors, run((req) => service.fork(req.viewer, slug(req)), 201));
    router.post('/:slug/like', guard('community.paste.write'), run((req) => service.like(req.viewer, slug(req))));
    router.post('/:slug/copy', guard('community.paste.write'), run((req) => service.copy(req.viewer, slug(req))));

    router.get('/:slug/comments', anyCap, run((req) => service.comments(req.viewer, slug(req), req.query)));
    router.post('/:slug/comments', guard('community.paste.write'), anonWriteLimiter, json, jsonErrors,
        run((req) => service.addComment(req.viewer, slug(req), req.body || {}, ctx(req)), 201));
    // Deleting someone else's comment is moderation: X-OV-Staff (with community.paste.moderate) for services.
    router.delete('/:slug/comments/:commentId', guard('community.paste.write'), run((req) => service.deleteComment(req.viewer, slug(req), req.params.commentId)));

    // Avatars belong to the Network account; Live's proxy set a Live-local avatar here.
    router.post('/:slug/set-avatar', (_req, res) => res.status(501).json({ error: 'Set your picture on openvibe.network' }));

    router.use((req, res) => res.status(404).json({ error: 'Not found' }));
    return router;
}

module.exports = { createPastesApi };
