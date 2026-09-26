'use strict';

/**
 * OpenVibe.Community — the people of OpenVibe.
 *
 * Express app factory (server/index.js listens; tests build their own instance).
 *
 *   Pages (server-rendered)            API / machine
 *   GET /               home           ALL /api/pastes/*       → see PASTES_AUTHORITY below
 *   GET /pastes         browse         /api/v1/comments/*      typed comment threads (comments/api.js)
 *   GET /p/:slug        paste          /api/v1/spaces/*, /api/v1/posts/*   forum (forum/api.js)
 *   GET /p/:slug/raw    raw text       /api/v1/pulse/*         Pulse (pulse/api.js)
 *   GET /p/:slug/screenshot → image    /api/v1/relay/*         Discord relay admin (relay/api.js)
 *   GET /p/:slug/download              GET /api/health, /api/ready, /release.json, /metrics (loopback)
 *   GET|POST /new       create         GET /robots.txt, /sitemap.xml, /feed.xml, /s/feed.xml
 *   GET /my             signed-in user's pastes                /auth/login|callback|logout|me|refresh
 *   GET /s …            spaces, threads, posts (forum/routes.js)    POST /release-metrics (open tabs' update reports)
 *   GET /pulse          the network's public activity
 *   GET|POST /c/:accessId   one comment thread's own page (comments/routes.js)
 *
 * Comments, the forum, Pulse and the relay live in Community's database in every mode.
 *
 * PASTES_AUTHORITY (config.pastesAuthority):
 *   'live' (default)  /api/pastes/* is a transparent proxy to OpenVibe.Live, pages read through
 *                     Live's API, raw text and screenshots bounce to OpenVibe.Media.
 *   'community'       this site's own database is the authority: the native API
 *                     (pastes/api.js), pages, raw text and screenshots all come from the store.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const live = require('./live-client');
const catalog = require('./pastes/catalog');
const source = require('./pastes/source');
const seo = require('./seo');
const pages = require('./render/pages');
const { assetVersion } = require('./render/layout');
const { createAuthClient, createAuthRoutes, optionalAuth } = require('./auth/routes');
const { createPastesProxy } = require('./pastes/proxy');
const { openDb, getDb } = require('./db');
const { createNetworkIdentity } = require('./identity/network');
const { createViewerResolver } = require('./identity/viewer');
const v1 = require('./http/v1');
const { createCommentService } = require('./comments/service');
const { createCommentsApi } = require('./comments/api');
const { createCommentPages } = require('./comments/routes');
const { createForumService } = require('./forum/service');
const { createVipGate } = require('./vip');
const { createSpacesApi, createPostsApi, createGroupsApi } = require('./forum/api');
const { createForumRoutes } = require('./forum/routes');
const { createPulse } = require('./pulse/service');
const { createPulseApi } = require('./pulse/api');
const { createDiscordRelay } = require('./relay/discord');
const { createRelayEventsWorker } = require('./relay/events-worker');
const { createDiscordGateway } = require('./relay/discord-gateway');
const { createDiscordInbound } = require('./relay/inbound');
const { createRelayApi } = require('./relay/api');
const { pulsePage } = require('./render/pulse');
const { extensionFor } = require('./render/highlight');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION = require('../package.json').version;

function createApp(opts = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // What this server runs (ADR-016); the shared navbar's release-watch polls it.
    const release = require('openvibe-shared/release').createRelease({ service: 'community', root: require('path').join(__dirname, '..') });
    // HTTP golden signals by route template, process metrics, release_info; GET /metrics answers
    // direct loopback callers only (Track O). Request metrics only: no content counts.
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'community', release: release.release });
    app.locals.metrics = metrics.registry;

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // Shared chrome (theme-loader, navbar, footer, history, ov-mark) comes from the Network.
                // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
                // measure performance; script-src loads the beacon, connect-src is where it reports.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://cdnjs.cloudflare.com', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com', 'https://openvibe.network'],
                fontSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://fonts.gstatic.com', 'data:'],
                // Screenshots serve from openvibe.media (which may 302 to object storage); avatars from Live/Network.
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.live', 'https://openvibe.media', 'https://events.openvibe.network', 'https://cloudflareinsights.com'],
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

    // ── Community's database, identity, and what lives in it in every mode ──
    const db = opts.db || (opts.dbPath ? openDb(opts.dbPath) : getDb());
    const network = opts.network || createNetworkIdentity({ config, db });
    // Network's per-person token cutoffs (network.user.token_valid_after): sign out everywhere, password
    // changes and bans refuse older tokens here at once (WS-B task 4).
    const revocations = require('openvibe-sdk/auth').createRevocationStore(db, { table: 'token_revocations' });
    const viewers = createViewerResolver({ auth, config, network, revocations });
    const pulse = createPulse({ db, network, config });
    const relay = opts.relay || createDiscordRelay({
        db, config, enabled: config.discordRelay.enabled,
        pollMs: config.discordRelay.pollMs, baseMs: config.discordRelay.backoffMs, maxAttempts: config.discordRelay.maxAttempts,
        webhookVars: config.discordRelay.webhookVars,
        ...(opts.relayOptions || {}),
    });
    // Its Events worker (creates from community.thread.* / community.post.*) and the inbound gateway;
    // both off unless configured (relay/events-worker.js, relay/discord-gateway.js, relay/inbound.js).
    const relayInbound = relay.enabled ? createDiscordInbound({ db, perMinute: config.discordRelay.inboundPerMinute, maxChars: config.discordRelay.inboundMaxChars, ...(opts.inboundOptions || {}) }) : null;
    if (!opts.relay) {
        relay.attach({
            worker: createRelayEventsWorker({
                db, relay, enabled: config.discordRelay.events, eventsUrl: config.discordRelay.eventsUrl, clientSecret: config.oauth.clientSecret,
                tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, pollMs: config.discordRelay.eventsPollMs, fetchImpl: opts.fetchImpl,
                ...(opts.relayWorkerOptions || {}),
            }),
            gateway: relayInbound && config.discordRelay.inbound ? createDiscordGateway({
                token: config.discordRelay.botToken, url: config.discordRelay.gatewayUrl,
                onDispatch: (type, data, ctx) => relayInbound.handle(type, data, ctx),
                ...(opts.gatewayOptions || {}),
            }) : null,
            inbound: relayInbound,
        });
    }
    // OpenVibe.VIP: members-only spaces and threads (fails closed without a client secret or VIP).
    const vip = opts.vip || createVipGate({ config, ...(opts.vipOptions || {}) });
    // Images on posts go to OpenVibe.Media's Object API as med_ objects (media/objects.js).
    const mediaObjects = opts.mediaObjects || require('./media/objects').createMediaObjects({ config });
    // A space's chat room on OpenVibe.Chat (chat-rooms.js): attached with the person's own token.
    const chatRooms = opts.chatRooms || require('./chat-rooms').createChatRooms({ config });
    const forum = createForumService({ db, network, pulse, relay, vip, media: mediaObjects, chatRooms, limits: opts.forumLimits });
    const community = config.pastesAuthority === 'community';
    const comments = createCommentService({ db, network, pastesLocal: community, limits: opts.commentLimits });
    seo.useForum(forum);
    Object.assign(app.locals, { db, network, pulse, relay, relayInbound, vip, forum, comments });
    if (opts.startRelay !== false) relay.start();

    // ── Paste authority ──────────────────────────────────────
    if (community) {
        const { createMediaFiles } = require('./media/files');
        const { createPasteService } = require('./pastes/service');
        // Screenshot bytes: OpenVibe.Media's Object API v2 (med_ objects, unlisted, owned by the person when signed in;
        // C-24), or the v1 community file store (legacy:community:file:<key>) without Community's service principal.
        const files = createMediaFiles({ config });
        const media = opts.media || {
            tokens: files.tokens,
            async upload({ buffer, filename, mime, owner = null }) {
                if (!mediaObjects.configured) return files.upload({ buffer, filename, mime });
                const o = await mediaObjects.uploadImage({ buffer, mime, filename, owner, kind: 'screenshot', source: 'community.paste' });
                return { key: o.id, url: o.url, size: o.size_bytes, mime, media_ref: o.id };
            },
        };
        const service = createPasteService({ db, network, media, config, limits: opts.pasteLimits, pulse });
        source.use(service);
        app.locals.pastes = service;
    } else {
        source.use(null);
    }
    // One anonymous-write budget per address, shared by the API and the no-JS form (20 / 10 min).
    const anonWriteLimiter = rateLimit({
        windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
        skip: (req) => !!(req.viewer ? req.viewer.kind !== 'anonymous' : req.user),
        handler: (req, res) => {
            const error = 'Too many anonymous posts — sign in or try again later';
            if (req.originalUrl.startsWith('/api/')) return res.status(429).json({ error });
            res.status(429).type('html').set('Cache-Control', 'no-cache').send(pages.newPage({ user: req.user, error }));
        },
    });

    // ── /api/pastes (before any body parser: in 'live' mode bodies stream through to Live) ──
    app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
    if (community) app.use('/api/pastes', require('./pastes/api').createPastesApi({ service: app.locals.pastes, viewers, anonWriteLimiter }));
    else app.use('/api/pastes', createPastesProxy({ liveUrl: opts.liveUrl }));

    // ── /api/v1: comments, forum, Pulse, relay admin ─────────
    // Opening a thread writes a row: browsers get 300 resolves per 10 minutes per address.
    const resolveLimiter = rateLimit({
        windowMs: 10 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
        skip: (req) => !!(req.viewer && req.viewer.kind === 'service'),
        message: { error: 'Too many requests — try again later' },
    });
    const cors = v1.cors(config.apiCorsOrigins);
    app.use('/api/v1/comments', cors, createCommentsApi({ service: comments, viewers, anonWriteLimiter, resolveLimiter }));
    app.use('/api/v1/pulse', cors, createPulseApi({ pulse, viewers }));
    // OpenVibe.Events → Pulse (server/pulse/consumer.js): public activity from Live, Blog, Wiki and News.
    const pulseConsumer = require('./pulse/consumer').createPulseConsumer({ db, vipCache: vip && vip.cache, revocations, secrets: String(process.env.COMMUNITY_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean) });
    app.locals.pulseConsumer = pulseConsumer;
    app.use('/internal/events', pulseConsumer.router);
    app.use('/api/v1/spaces', createSpacesApi({ forum, viewers }));
    app.use('/api/v1/posts', createPostsApi({ forum, viewers }));
    app.use('/api/v1/space-groups', createGroupsApi({ forum, viewers }));
    app.use('/api/v1/relay', createRelayApi({ relay, db, viewers, inbound: relayInbound }));

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-community', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports (a same-origin
    // sendBeacon, no auth) into /metrics as release_client_updates_total.
    release.mount(app, { registry: metrics.registry });
    // Readiness reports what is actually served: 503 only without the database; Network key,
    // Live (live mode) and Media (community mode) failures degrade (server/observability.js).
    const readiness = require('./observability').createCommunityReadiness({ db, auth, config, relay, release: release.release, fetchImpl: opts.fetchImpl });
    app.get('/api/ready', readiness.handler);

    // ── Static assets (content-hashed ?v= → immutable) ───────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
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
    app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(seo.llmsTxt()));
    app.get('/sitemap.xml', seo.sitemapHandler);
    app.get('/feed.xml', wrap(seo.feedHandler));

    // ── Pages ────────────────────────────────────────────────
    // Pages are for browsers: in community mode the viewer (subject, staff) is resolved too.
    const withUser = community ? viewers.middleware({ services: false }) : optionalAuth(auth);
    const ctxOf = (req) => ({ token: req.token, ip: req.ip, userAgent: req.get('user-agent') || '', viewer: req.viewer });
    const html = (res, body, status = 200) => res.status(status).type('html').set('Cache-Control', 'no-cache').send(body);

    app.get('/', withUser, wrap(async (req, res) => {
        const [latest, trending, languages] = await Promise.all([catalog.latest(12), catalog.trending(8), catalog.languages()]);
        html(res, pages.homePage({ latest, trending, languages, user: req.user }));
    }));

    app.get('/updates', (req, res) => html(res, pages.updatesPage()));

    // Threads and pastes through OpenVibe.Search (server/search/query.js); the paste filter below works without it.
    const searchQuery = opts.searchQuery || require('./search/query').createSearchQuery({ baseUrl: config.searchInternalUrl });
    app.get('/search', withUser, wrap(async (req, res) => {
        const q = String(req.query.q || '').trim().slice(0, 200);
        const type = ['thread', 'paste'].includes(req.query.type) ? req.query.type : '';
        const { searchPage } = require('./render/search');
        if (!q) return html(res, searchPage({ q, type }));
        try {
            const out = await searchQuery.search({ q, type, cursor: String(req.query.cursor || '') });
            html(res, searchPage({ q, type, results: out.results, nextCursor: out.next_cursor }));
        } catch (err) {
            if (!err || !err.unavailable) throw err;
            console.warn('[Search] /search:', err.message);
            html(res, searchPage({ q, type, unavailable: true }), 503);
        }
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
            paste = await source.getPaste(slug, ctxOf(req));
        } catch (err) {
            if (err.status === 404) return html(res, pages.errorPage({ status: 404, title: 'Paste not found', message: 'It may have been deleted, burned after reading, or never existed.' }), 404);
            if (err.status === 410) return html(res, pages.errorPage({ status: 410, title: 'This paste has burned', message: 'It was set to burn after reading, and it has been read.' }), 410);
            throw err;
        }
        const related = await catalog.related(paste, 6);
        html(res, pages.pastePage({ paste, related, user: req.user }));
    }));

    if (community) {
        // The store is the authority: raw text is served here, the screenshot link is the stored
        // Media URL. (Never bounce to Media's /p/… — after cutover it redirects back here.)
        const notFound = (res) => res.status(404).type('text/plain').set('X-Content-Type-Options', 'nosniff').send('Not found');
        app.get('/p/:slug/raw', withUser, (req, res) => {
            if (!SLUG_RE.test(req.params.slug)) return notFound(res);
            try {
                const out = app.locals.pastes.raw(req.viewer, req.params.slug, ctxOf(req));
                if (out.redirect) return res.redirect(302, out.redirect);
                res.set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'private, no-store');
                res.type('text/plain; charset=utf-8').send(out.content);
            } catch (err) {
                if (err.status === 410) return res.status(410).type('text/plain').set('X-Content-Type-Options', 'nosniff').send('This paste has been burned after reading.');
                if (err.status === 404) return notFound(res);
                throw err;
            }
        });
        app.get('/p/:slug/screenshot', withUser, (req, res) => {
            if (!SLUG_RE.test(req.params.slug)) return notFound(res);
            try { res.redirect(302, app.locals.pastes.screenshotUrl(req.viewer, req.params.slug)); }
            catch (err) { if (err.status === 404) return notFound(res); throw err; }
        });
    } else {
        // Raw text and screenshots are public on OpenVibe.Media — bounce there.
        app.get('/p/:slug/raw', (req, res) => res.redirect(302, live.rawUrl(req.params.slug)));
        app.get('/p/:slug/screenshot', (req, res) => res.redirect(302, live.screenshotUrl(req.params.slug)));
    }

    app.get('/p/:slug/download', withUser, wrap(async (req, res) => {
        const { slug } = req.params;
        if (!SLUG_RE.test(slug)) return res.status(404).type('text/plain').send('Not found');
        let paste;
        try { paste = await source.getPaste(slug, { ...ctxOf(req), noView: true }); }
        catch (err) { if (err.status === 404 || err.status === 410) return res.status(err.status).type('text/plain').send('Not found'); throw err; }
        if (paste.type === 'screenshot') return res.redirect(302, community ? (paste.screenshot_url || `/p/${encodeURIComponent(slug)}/screenshot`) : live.screenshotUrl(slug));
        res.set('Content-Disposition', `attachment; filename="${slug}.${extensionFor(paste.language)}"`);
        res.set('Cache-Control', 'private, no-cache');
        res.type('text/plain; charset=utf-8').send(String(paste.content || ''));
    }));

    app.get('/new', withUser, wrap(async (req, res) => {
        let fork = null;
        if (req.query.fork && SLUG_RE.test(String(req.query.fork))) {
            try { const p = await source.getPaste(String(req.query.fork), { ...ctxOf(req), noView: true }); if (p && p.type === 'paste') fork = p; } catch { /* no fork, plain form */ }
        }
        html(res, pages.newPage({ user: req.user, fork }));
    }));

    // No-JS fallback: a plain form post becomes the same JSON create the API path uses.
    // In community mode the anonymous-write budget applies here too (in 'live' mode Live enforces it).
    const formLimiter = community ? anonWriteLimiter : (_req, _res, next) => next();
    app.post('/new', withUser, formLimiter, express.urlencoded({ extended: false, limit: '1mb' }), wrap(async (req, res) => {
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
            const out = await source.createPaste({
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

    // ── Forum and Pulse pages ────────────────────────────────
    app.use(createForumRoutes({ forum, viewers, config }));
    app.use(createCommentPages({ comments, viewers, config }));
    app.get('/pulse', viewers.middleware({ services: false }), wrap(async (req, res) => {
        const origin = pulse.ORIGINS.includes(req.query.origin) ? req.query.origin : '';
        let out;
        try { out = await pulse.list({ origin, after: req.query.after }); }
        catch (err) { if (err instanceof v1.ApiError) return res.redirect(302, origin ? `/pulse?origin=${origin}` : '/pulse'); throw err; }
        html(res, pulsePage({ items: out.items, origin, after: req.query.after || null, nextCursor: out.next_cursor }));
    }));

    app.get('/my', withUser, wrap(async (req, res) => {
        if (!req.user) return res.redirect(`/auth/login?next=${encodeURIComponent('/my')}`);
        let pastes = [], total = 0, error = null;
        try {
            const out = await source.listByUser(req.user.username, { limit: 100 }, ctxOf(req));
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
