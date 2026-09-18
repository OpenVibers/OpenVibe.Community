'use strict';

/**
 * OpenVibe.Community — the people of OpenVibe.
 *
 * Express app factory (server/index.js listens; tests build their own instance).
 *
 *   Pages (server-rendered)            API / machine
 *   GET /               home           ALL /api/pastes/*       → OpenVibe.Live proxy
 *   GET /pastes         browse         GET /api/health, /api/ready
 *   GET /p/:slug        paste          GET /robots.txt, /sitemap.xml, /feed.xml
 *   GET /p/:slug/raw    → Media        /auth/login|callback|logout|me|refresh
 *   GET /p/:slug/screenshot → Media
 *   GET /p/:slug/download
 *   GET|POST /new       create
 *   GET /my             signed-in user's pastes
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const live = require('./live-client');
const catalog = require('./pastes/catalog');
const seo = require('./seo');
const pages = require('./render/pages');
const { assetVersion } = require('./render/layout');
const { createAuthClient, createAuthRoutes, optionalAuth } = require('./auth/routes');
const { createPastesProxy } = require('./pastes/proxy');
const { extensionFor } = require('./render/highlight');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION = require('../package.json').version;

function createApp(opts = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // Shared chrome (theme-loader, navbar, footer, history, ov-mark) comes from the Network.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://cdnjs.cloudflare.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com', 'https://openvibe.network'],
                fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com', 'data:'],
                // Screenshots serve from openvibe.media (which may 302 to object storage); avatars from Live/Network.
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.live', 'https://openvibe.media'],
                // The Network's hidden /sso/check frame: how a visitor who is signed in elsewhere gets signed in here.
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
                scriptSrcAttr: ["'unsafe-inline'"],
            },
        },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Auth (OAuth2 client of OpenVibe.Network) ─────────────
    const auth = opts.auth || createAuthClient(config);
    app.locals.auth = auth;
    app.locals.config = config;
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'community', service: 'community', host: 'openvibe.community', name: 'OpenVibe.Community', profile: 'ugc' })); app.get('/tos', (_req, res) => res.redirect(301, '/terms')); }

    // ── /api/pastes → OpenVibe.Live (before any body parser: bodies stream through) ──
    app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
    app.use('/api/pastes', createPastesProxy({ liveUrl: opts.liveUrl }));

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-community', version: VERSION }));
    app.get('/api/ready', (_req, res) => res.json({ ready: true }));

    // ── Static assets (content-hashed ?v= → immutable) ───────
    app.use(express.static(PUBLIC_DIR, {
        index: false, etag: true, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            if (v && v === assetVersion(rel)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            else if (/\.(svg|png|ico|webmanifest)$/.test(rel)) res.setHeader('Cache-Control', 'public, max-age=86400');
            else res.setHeader('Cache-Control', 'no-cache');
        },
    }));

    // ── Machine endpoints ────────────────────────────────────
    app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.robotsTxt()));
    app.get('/sitemap.xml', seo.sitemapHandler);
    app.get('/feed.xml', wrap(seo.feedHandler));

    // ── Pages ────────────────────────────────────────────────
    const withUser = optionalAuth(auth);
    const ctxOf = (req) => ({ token: req.token, ip: req.ip });
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);

    app.get('/', withUser, wrap(async (req, res) => {
        const [latest, trending, languages] = await Promise.all([catalog.latest(12), catalog.trending(8), catalog.languages()]);
        html(res, pages.homePage({ latest, trending, languages, user: req.user }));
    }));

    app.get('/pastes', withUser, wrap(async (req, res) => {
        const [result, languages] = await Promise.all([catalog.browse(req.query), catalog.languages()]);
        html(res, pages.browsePage(result, languages));
    }));

    // Old Live-style /pastes/<slug> links and bare slugs land on the paste page.
    app.get('/pastes/:slug', (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.slug)}`));

    app.get('/p/:slug', withUser, wrap(async (req, res) => {
        const { slug } = req.params;
        if (!SLUG_RE.test(slug)) return html(res, pages.errorPage({ status: 404, title: 'Paste not found', message: 'That link does not point at a paste.' }), 404);
        let paste;
        try {
            paste = await live.getPaste(slug, ctxOf(req));
        } catch (err) {
            if (err.status === 404) return html(res, pages.errorPage({ status: 404, title: 'Paste not found', message: 'It may have been deleted, burned after reading, or never existed.' }), 404);
            if (err.status === 410) return html(res, pages.errorPage({ status: 410, title: 'This paste has burned', message: 'It was set to burn after reading, and it has been read.' }), 410);
            throw err;
        }
        const related = await catalog.related(paste, 6);
        html(res, pages.pastePage({ paste, related, user: req.user }));
    }));

    // Raw text and screenshots are public on OpenVibe.Media — bounce there.
    app.get('/p/:slug/raw', (req, res) => res.redirect(302, live.rawUrl(req.params.slug)));
    app.get('/p/:slug/screenshot', (req, res) => res.redirect(302, live.screenshotUrl(req.params.slug)));

    app.get('/p/:slug/download', withUser, wrap(async (req, res) => {
        const { slug } = req.params;
        if (!SLUG_RE.test(slug)) return res.status(404).type('text/plain').send('Not found');
        let paste;
        try { paste = await live.getPaste(slug, { ...ctxOf(req), noView: true }); }
        catch (err) { if (err.status === 404 || err.status === 410) return res.status(err.status).type('text/plain').send('Not found'); throw err; }
        if (paste.type === 'screenshot') return res.redirect(302, live.screenshotUrl(slug));
        res.set('Content-Disposition', `attachment; filename="${slug}.${extensionFor(paste.language)}"`);
        res.set('Cache-Control', 'private, no-cache');
        res.type('text/plain; charset=utf-8').send(String(paste.content || ''));
    }));

    app.get('/new', withUser, wrap(async (req, res) => {
        let fork = null;
        if (req.query.fork && SLUG_RE.test(String(req.query.fork))) {
            try { const p = await live.getPaste(String(req.query.fork), { ...ctxOf(req), noView: true }); if (p && p.type === 'paste') fork = p; } catch { /* no fork, plain form */ }
        }
        html(res, pages.newPage({ user: req.user, fork }));
    }));

    // No-JS fallback: a plain form post becomes the same JSON create the API path uses.
    app.post('/new', withUser, express.urlencoded({ extended: false, limit: '1mb' }), wrap(async (req, res) => {
        const b = req.body || {};
        const values = {
            title: String(b.title || '').slice(0, 200),
            language: String(b.language || 'auto'),
            content: String(b.content || ''),
            visibility: ['public', 'unlisted', 'private'].includes(b.visibility) ? b.visibility : 'public',
            burn_after_read: !!b.burn_after_read,
            is_nsfw: !!b.is_nsfw,
        };
        if (values.visibility === 'private' && !req.user) values.visibility = 'unlisted';
        if (!values.content.trim()) return html(res, pages.newPage({ user: req.user, values, error: 'Paste something first — the content is empty.' }), 400);
        try {
            const out = await live.createPaste({
                title: values.title, content: values.content, language: values.language, visibility: values.visibility,
                burn_after_read: values.burn_after_read, is_nsfw: values.is_nsfw,
            }, ctxOf(req));
            const slug = (out && (out.slug || (out.paste && out.paste.slug))) || null;
            if (!slug) throw new Error('Paste service returned no slug');
            catalog.reset();
            return res.redirect(303, `/p/${encodeURIComponent(slug)}`);
        } catch (err) {
            const msg = (err.body && err.body.error) || (err.status ? `The paste service said no (${err.status}).` : 'The paste service is unavailable right now — try again in a moment.');
            return html(res, pages.newPage({ user: req.user, values, error: msg }), err.status && err.status < 500 ? err.status : 502);
        }
    }));

    app.get('/my', withUser, wrap(async (req, res) => {
        if (!req.user) return res.redirect(`/auth/login?next=${encodeURIComponent('/my')}`);
        let pastes = [], total = 0, error = null;
        try {
            const out = await live.listByUser(req.user.username, { limit: 100 }, ctxOf(req));
            pastes = (out && out.pastes) || [];
            total = Number(out && out.total) || pastes.length;
        } catch (err) {
            if (err.status !== 404) error = 'Your pastes could not be loaded right now.';
        }
        html(res, pages.myPage({ user: req.user, pastes, total, error }));
    }));

    // ── 404 / errors ─────────────────────────────────────────
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
        html(res, pages.errorPage({ status: 404, title: 'Page not found', message: 'Nothing lives at that address.' }), 404);
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        const upstream = err && err.name === 'LiveApiError';
        if (!upstream) console.error('[App]', err && err.stack ? err.stack : err);
        else console.warn('[App] upstream:', err.status, err.message);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return res.status(upstream ? 502 : 500).json({ error: upstream ? 'Paste service unavailable' : 'Internal error' });
        html(res, pages.errorPage({
            status: upstream ? 502 : 500,
            title: upstream ? 'The paste service is taking a break' : 'Something went wrong',
            message: upstream ? 'OpenVibe.Live did not answer. Pastes come back the moment it does — try again in a minute.' : 'This one is on us. Please try again.',
        }), upstream ? 502 : 500);
    });

    return app;
}

/** Async route wrapper — rejections reach the error handler. */
function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

module.exports = { createApp };
