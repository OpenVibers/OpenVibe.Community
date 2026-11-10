'use strict';

/**
 * OpenVibe.Community — the people of OpenVibe.
 *
 * Express app factory (server/index.js listens; tests build their own instance).
 *
 *   Pages (server-rendered)            API / machine
 *   GET /               home           ALL /api/pastes/*       the native paste API (pastes/api.js)
 *   GET /pastes         browse         /api/v1/comments/*      typed comment threads (comments/api.js)
 *   GET /p/:slug        paste          /api/v1/spaces/*, /api/v1/posts/*   forum (forum/api.js)
 *   POST /p/:slug/comments  comment on it (its typed thread)
 *   GET /p/:slug/raw    raw text       /api/v1/pulse/*         Pulse (pulse/api.js)
 *   GET /p/:slug/screenshot → image    /api/v1/relay/*         Discord relay admin (relay/api.js)
 *   GET /p/:slug/download              GET /api/health, /api/ready, /release.json, /metrics (loopback)
 *   GET|POST /new       create         GET /robots.txt, /llms.txt, /llms-full.txt, /sitemap.xml, /feed.xml, /forum/feed.xml
 *   GET /my             signed-in user's pastes                /auth/login|callback|logout|me|refresh
 *   GET /forum …        spaces, threads, posts (forum/routes.js)    POST /release-metrics (open tabs' update reports)
 *   GET /s …            301/308 to /forum (old forum links)
 *   GET /pulse          the network's public activity
 *   GET|POST /c/:accessId   one comment thread's own page (comments/routes.js)
 *   GET|POST /submissions …  submissions, their pages and the review queue (submissions/routes.js)
 *                                      /api/v1/submissions/*   submissions (submissions/api.js)
 *
 * Comments, the forum, Pulse and the relay live in Community's database, alongside the pastes
 * Community itself is the only authority for: the native API (pastes/api.js), pages, raw text
 * and screenshots all come from the store.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const catalog = require('./pastes/catalog');
const source = require('./pastes/source');
const discovery = require('./discovery');
const pages = require('./render/pages');
const { assetVersion, SITE_NAME, DEFAULT_DESCRIPTION, setRobotsHeader } = require('./render/layout');
const { createAuthClient, createAuthRoutes } = require('./auth/routes');
const { getDb } = require('./db');
const { createNetworkIdentity } = require('./identity/network');
const { createViewerResolver, ANONYMOUS } = require('./identity/viewer');
const v1 = require('./http/v1');
const { createCommentService } = require('./comments/service');
const { createSharing, describeRef } = require('./sharing');
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
const { createActorLimits } = require('./actor-limits');
const { createSubmissionService } = require('./submissions/service');
const { createSubmissionsApi } = require('./submissions/api');
const { createSubmissionPages } = require('./submissions/routes');
const { pulsePage } = require('./render/pulse');
const { extensionFor } = require('./render/highlight');
const { createIndexNow } = require('openvibe-shared/indexnow');
const { createPasteService } = require('./pastes/service');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
// A card asks the screenshot proxy for one of Media's two card widths (?w=320|640&fmt=webp). The
// format is in the URL, never negotiated: a shared cache stores by URL and ignores Vary.
const SHOT_CARD_WIDTHS = new Set([320, 640]);
function screenshotVariant(query = {}) {
    if (query.w === undefined && query.fmt === undefined) return null;
    const w = Number(query.w);
    const fmt = String(query.fmt || 'webp').toLowerCase();
    if (!SHOT_CARD_WIDTHS.has(w) || fmt !== 'webp') return { error: 'w must be 320 or 640 and fmt webp' };
    return { w, fmt };
}
const pasteRef = (slug) => ({ service: 'community', type: 'paste', id: String(slug) });
const VERSION = require('../package.json').version;
// The date /.well-known/security.txt must be refreshed by: one year on, a person re-reads and re-commits it.
const SECURITY_EXPIRES = '2027-10-29T00:00:00.000Z';
// Pages are rendered for the person reading them (and a form post redirects back to them), so no
// shared or browser cache keeps one.
const PAGE_CACHE = cache.htmlHeaders({ private: true });

async function createApp(opts = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    // What this server runs (ADR-016); the shared navbar's release-watch polls it.
    const release = require('openvibe-shared/release').createRelease({ service: 'community', root: require('path').join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    // HTTP golden signals by route template, process metrics, release_info; GET /metrics answers
    // direct loopback callers only (Track O). Request metrics only: no content counts.
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'community', release: release.release });
    app.use(require('openvibe-sdk/service').telemetryMiddleware);   // request telemetry: a no-op until server/index.js calls telemetry.init()
    app.locals.metrics = metrics.registry;

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // Shared chrome (theme-loader, navbar, footer, history, ov-mark) comes from the Network.
                // Cloudflare Web Analytics: Cloudflare injects its beacon at the edge and the privacy text says it may
                // measure performance; script-src loads the beacon, connect-src is where it reports.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://openvibe.network'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
                // Screenshots serve from openvibe.media (which may 302 to object storage); avatars from Live/Network.
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                connectSrc: ["'self'", 'https://openvibe.network', 'https://openvibe.chat', 'https://openvibe.live', 'https://openvibe.media', 'https://openvibe.events', 'https://inventory.openvibe.network', 'https://cloudflareinsights.com'],   // inventory: what people wear (items.js)
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
    // /auth/me is the navbar's who-is-signed-in read on every page, so it is not counted with sign-ins: 60 page views in 15 minutes made a signed-in visitor look signed out.
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60, skip: (req) => req.path === '/me', standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', createAuthRoutes(config, auth));
    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'community', service: 'community', host: 'openvibe.community', name: 'OpenVibe.Community', profile: 'ugc' })); app.get('/tos', (_req, res) => res.redirect(301, '/terms')); }

    // ── Community's database, identity, and what lives in it in every mode ──
    const db = opts.db || getDb();
    const network = opts.network || createNetworkIdentity({ config, db });
    // Network's per-person token cutoffs (network.user.token_valid_after): sign out everywhere, password
    // changes and bans refuse older tokens here at once (WS-B task 4).
    // Cutoffs are read into memory before the app serves: isRevoked() is synchronous on every signed-in request.
    const revocations = require('openvibe-sdk/auth').createPgRevocationStore(db, { table: 'token_revocations' });
    await revocations.load();
    const viewers = createViewerResolver({ auth, config, network, revocations });
    const pulse = createPulse({ db, network, config });
    // Public activity without an Events topic (Today's calendar, Network's open stats, Quest badges): a due-based
    // job that fills Pulse, started by server/index.js and never called while a feed request is being answered.
    const pulseSources = require('./pulse/sources').createPulseSources({
        db, config, fetchImpl: opts.sourcesFetch || opts.fetchImpl || globalThis.fetch, ...(opts.pulseSources || {}),
    });
    app.locals.pulseSources = pulseSources;
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
                onDispatch: async (type, data, ctx) => await relayInbound.handle(type, data, ctx),
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
    // IndexNow (openvibe-shared/indexnow): created once at boot from INDEXNOW_KEY; unset → off
    // (nothing mounted, nothing sent). The key file is served at /<key>.txt and the paste and forum
    // services ping the engines when a public, indexable page appears, changes or goes away.
    const indexnow = opts.indexnow || createIndexNow({ host: config.baseUrl, key: config.indexnow.key, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) });
    const forum = createForumService({ db, network, pulse, relay, vip, media: mediaObjects, chatRooms, limits: opts.forumLimits, config, indexnow });
    // Screenshot bytes: OpenVibe.Media's Object API v2 (a private med_ object owned by the person when
    // signed in), or the v1 community file store (legacy:community:file:<key>) without Community's
    // service principal. A private object is reachable only with Community's token, so every read goes
    // through the page's proxy (canView) and the Media URL is never put in HTML.
    const { createMediaFiles } = require('./media/files');
    const mediaFiles = createMediaFiles({ config });
    const pasteMedia = opts.media || {
        tokens: mediaFiles.tokens,
        async upload({ buffer, filename, mime, owner = null, visibility = 'private' }) {
            if (!mediaObjects.configured) return await mediaFiles.upload({ buffer, filename, mime });
            const o = await mediaObjects.uploadImage({ buffer, mime, filename, owner, kind: 'screenshot', source: 'community.paste', visibility });
            return { key: o.id, url: o.url, size: o.size_bytes, mime, media_ref: o.id, private: visibility === 'private' };
        },
        /** A paste's screenshot bytes, for the proxy (a private object through a signed download). */
        async bytes(row, variant = null) {
            // A card's ?w=&fmt= rides on the same URL Media answered: public objects take it openly, a
            // private one through the signature already in the URL (Media checks both before resizing).
            const withVariant = (url) => (!variant ? url : `${url}${url.includes('?') ? '&' : '?'}w=${variant.w}&fmt=${variant.fmt}`);
            const ref = String(row.media_ref || '');
            const id = /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(ref) ? ref : (String(row.screenshot_url || '').match(/\/o\/(med_[0-9A-HJKMNP-TV-Z]{26})/) || [])[1];
            if (id && mediaObjects.configured) {
                try {
                    const url = withVariant(await mediaObjects.downloadUrl(id));
                    const res = await (opts.fetchImpl || globalThis.fetch)(url, { signal: AbortSignal.timeout(30_000) });
                    if (res.ok) return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'application/octet-stream' };
                } catch { /* an unlisted object still answers its stored URL below */ }
            }
            if (!row.screenshot_url) return null;
            const res = await (opts.fetchImpl || globalThis.fetch)(withVariant(row.screenshot_url), { signal: AbortSignal.timeout(30_000) });
            if (!res.ok) return null;
            return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'application/octet-stream' };
        },
        /**
         * The screenshot follows a transfer: re-host the same bytes privately, owned by the new owner,
         * then delete the old object (a legacy object is left to the move script, which checks other
         * references before retiring it). previous_media_ref is recorded before the delete, so a
         * failure is retried by scripts/move-screenshots-private.js instead of leaving the old URL
         * readable.
         */
        async moveOwner(row, owner) {
            if (!owner || !mediaObjects.configured) return false;
            const got = await this.bytes(row);
            if (!got) return false;
            const old = /^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(row.media_ref || '')) ? String(row.media_ref)
                : (String(row.screenshot_url || '').match(/\/o\/(med_[0-9A-HJKMNP-TV-Z]{26})/) || [])[1] || null;
            const meta = (() => { try { const o = JSON.parse(row.metadata || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; } })();
            const stored = await mediaObjects.uploadImage({ buffer: got.body, mime: got.type, filename: `${row.slug}-owned.png`, owner, kind: 'screenshot', source: 'community.paste', visibility: 'private' });
            const next = { ...meta, media_visibility: 'private', ...(old ? { previous_media_ref: old } : {}) };
            await db.prepare('UPDATE pastes SET screenshot_url = ?, media_ref = ?, metadata = ?, updated_at = ov_now() WHERE slug = ?')
                .run(stored.url, stored.id, JSON.stringify(next), row.slug);
            if (old) {
                try {
                    try {
                        await mediaObjects.deleteObject(old);
                    } catch (err) {
                        // A 404 is a legacy Live paste screenshot, not "already gone": retire it. A 409
                        // legacy_managed (an old Community v1 file) waits for the move script, which checks
                        // that no other paste, post or attachment still references the id.
                        if (err.status !== 404) throw err;
                        await mediaObjects.retireLegacyPaste(old);
                    }
                    delete next.previous_media_ref;
                    await db.prepare('UPDATE pastes SET metadata = ?, updated_at = ov_now() WHERE slug = ?').run(JSON.stringify(next), row.slug);
                } catch (err) { console.warn(`[Sharing] old screenshot ${old} not deleted (the move script retries): ${err.message}`); }
            }
            return true;
        },
    };
    // Sharing (openvibe-sdk/share): the one access check for a paste, its members, transfers and the
    // gate. Created before comments so a thread on a paste nobody may see is never readable.
    const sharing = opts.sharing || createSharing({ db, media: pasteMedia, fetchImpl: opts.fetchImpl });
    const comments = createCommentService({ db, network, limits: opts.commentLimits, canViewPaste: (v, p) => sharing.canViewPaste(v, p) });
    // Submissions (clips, art, ideas, reports for review): their own table, not tied to the forum.
    const submissions = createSubmissionService({ db, network, pulse, indexnow, config, limits: opts.submissionLimits });
    discovery.useForum(forum);
    Object.assign(app.locals, { db, network, pulse, relay, relayInbound, vip, forum, comments, submissions, indexnow, sharing });
    if (opts.startRelay !== false) relay.start();

    // ── Pastes: Community's own store is the only authority ──
    {
        const review = opts.review || require('./pastes/review').createPasteReview({ config });
        const service = createPasteService({ db, network, media: pasteMedia, config, limits: opts.pasteLimits, pulse, indexnow, shares: sharing, review });
        source.use(service);
        app.locals.pastes = service;
        app.locals.pasteMedia = pasteMedia;
        app.locals.pasteReview = review;
    }
    // One anonymous-write budget per address, shared by the API and the no-JS form (20 / 10 min).
    const anonWriteLimiter = rateLimit({
        windowMs: 10 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
        skip: (req) => !!(req.viewer ? req.viewer.kind !== 'anonymous' : req.user),
        handler: (req, res) => {
            const error = 'Too many anonymous posts — sign in or try again later';
            if (req.originalUrl.startsWith('/api/')) return res.status(429).json({ error });
            res.status(429).type('html').set('Cache-Control', PAGE_CACHE).send(pages.newPage({ user: req.user, error }));
        },
    });

    // Per-actor limits for every API router below (server/actor-limits.js), after each one resolves its
    // viewer; the per-address /api/ limit stays in front. opts.actorLimits: { limits, now } (tests).
    // Valkey (ADR-035): the per-actor limit counters, shared across processes; opts.valkey for tests (null: none).
    const valkey = opts.valkey !== undefined ? opts.valkey
        : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix }) : null);
    app.locals.valkey = valkey;
    const limits = createActorLimits({ registry: metrics.registry, valkey, ...(opts.actorLimits || {}) });

    // ── /api/pastes — the native paste API ───────────────────
    // GET /openapi.json: the API document, generated from the table the /api routers mount (server/openapi.js).
    // Mounted before them, because each router ends with a 404 for anything it does not serve.
    require('./openapi').mount(app);
    app.use('/api/', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
    app.use('/api/pastes', require('./pastes/api').createPastesApi({ service: app.locals.pastes, viewers, anonWriteLimiter, limits }));
    // ── /api/v1/submissions — clips, art, ideas and reports for community review ──
    app.use('/api/v1/submissions', v1.cors(config.apiCorsOrigins), createSubmissionsApi({ submissions, viewers, limits }));

    // ── /api/v1: comments, forum, Pulse, relay admin ─────────
    // Opening a thread writes a row: browsers get 300 resolves per 10 minutes per address.
    const resolveLimiter = rateLimit({
        windowMs: 10 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
        skip: (req) => !!(req.viewer && req.viewer.kind === 'service'),
        message: { error: 'Too many requests — try again later' },
    });
    const cors = v1.cors(config.apiCorsOrigins);
    app.use('/api/v1/comments', cors, createCommentsApi({ service: comments, viewers, anonWriteLimiter, resolveLimiter, limits }));
    // The menu's wall and Feed on every OpenVibe site read these: public reads from any origin, writes from the listed ones.
    const readCors = v1.publicReadCors(config.apiCorsOrigins);
    app.use('/api/v1/pulse', readCors, createPulseApi({ pulse, viewers, limits }));
    // The menu's Feed on every site: one stream from Pulse with the network's trending pictures and videos (pulse/feed.js).
    app.use('/api/v1/feed', readCors, require('./pulse/feed').createFeedApi({ pulse, viewers, limits, db, networkUrl: config.networkUrl, liveUrl: config.liveUrl, fetchImpl: opts.feedFetch || opts.fetchImpl || globalThis.fetch }));
    app.use('/api/v1/me/status', cors, require('./status/api').createStatusApi({ forum, pulse, viewers, limits, db, baseUrl: config.baseUrl }));
    app.use('/api/v1/profiles', cors, require('./status/api').createProfileStatusApi({ viewers, limits, db, baseUrl: config.baseUrl }));
    // OpenVibe.Events → Pulse (server/pulse/consumer.js): public activity from Live, Blog, Wiki and News.
    const pulseConsumer = require('./pulse/consumer').createPulseConsumer({ db, vipCache: vip && vip.cache, revocations, accountSend: config.oauth && config.oauth.clientSecret ? require('./identity/account-data').createSender({ config }) : null, secrets: String(process.env.COMMUNITY_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean) });
    app.locals.pulseConsumer = pulseConsumer;
    // Never per-actor limited: Events pushes at its own pace (a 429 only makes it retry and fall behind),
    // and these deliveries carry token cutoffs and account deletions.
    app.use('/internal/events', pulseConsumer.router);
    app.use('/api/v1/spaces', createSpacesApi({ forum, viewers, limits }));
    app.use('/api/v1/posts', createPostsApi({ forum, pulse, viewers, limits, baseUrl: config.baseUrl }));
    app.use('/api/v1/space-groups', createGroupsApi({ forum, viewers, limits }));
    app.use('/api/v1/relay', createRelayApi({ relay, db, viewers, inbound: relayInbound, limits }));
    // OpenVibe.Services reads a person's pastes and spaces here (community.resource.read, a service token on loopback;
    // nginx answers 404 for the path on the public vhost).
    // Control first (community.resource.control: delete a person's paste), then the index.
    app.use('/api/v1/resources/control', require('./registry/resource-control').router({ db, viewers, pastes: app.locals.pastes }));
    app.use('/api/v1/resources', require('./registry/resource-index').router({ db, viewers }));

    // ── /api/v1/<kind>/<id>/share — the uniform share API (openvibe-sdk/share) ────
    // GET/PUT /api/v1/paste/:slug/share, .../share/requests, .../share/transfer[/accept|decline|cancel],
    // GET /api/v1/share/people?name=, GET /api/v1/shared-with-me. The sheet and agents use these; access
    // is still decided by canView on every paste read. Authentication is Community's own viewer (the
    // cookie with the SDK's CSRF marker, or a bearer token); the router answers only its own paths.
    {
        const shareApi = express.Router();
        shareApi.use(viewers.middleware());
        // The whole share call runs as the person it is for, so a locker key lookup asks as them (server/sharing.js).
        shareApi.use((req, res, next) => sharing.withActor(req.viewer, next));
        shareApi.use(sharing.shares.router({
            service: 'community',
            authenticate: (req) => sharing.shareViewer(req.viewer),
            describe: describeRef(db),
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        app.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }
    // Expire members and transfers and send queued share events/notifications. It first runs after
    // boot, once Events is up (a delivery sent before its outbox exists would be marked sent).
    if (opts.startSharingWorker !== false) {
        const timer = setInterval(() => { sharing.work().catch(() => { /* logged inside */ }); }, 15_000);
        if (timer.unref) timer.unref();
        app.locals.sharingTimer = timer;
    }

    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-community', version: VERSION }));
    // GET /release.json (ADR-016) and POST /release-metrics: open tabs' update reports (a same-origin
    // sendBeacon, no auth) into /metrics as release_client_updates_total.
    release.mount(app, { registry: metrics.registry });
    // Readiness reports what is actually served: 503 only without the database; the Network key
    // and Media failures degrade (server/observability.js).
    const readiness = require('./observability').createCommunityReadiness({ db, auth, config, relay, release: release.release, fetchImpl: opts.fetchImpl, valkey });
    app.get('/api/ready', readiness.handler);

    // ── Static assets (content-hashed ?v= → immutable) ───────
    // This site's own pinned copy of the OpenVibe Frame's browser files (openvibe-shared/serve).
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, etag: true, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // The menu's network card (frame.menu-cards@1): the forum's most replied-to threads this week, else its newest
    // public threads. Both come from the forum's own public queries (server/forum/store.js) so gated and
    // members-only spaces, deleted threads and 18+ threads stay out.
    {
        const { createMenuCard } = require('./menu-card');
        const menuCard = createMenuCard({
            load: async () => await forum.hotThisWeek(6),
            loadNewest: async () => await forum.newestPublic(12),
        });
        app.get('/.well-known/openvibe-menu.json', menuCard.handler);
    }

    // ── Machine endpoints ────────────────────────────────────
    // Written by openvibe-shared/seo from server/discovery.js; the sitemap is rebuilt at most hourly.
    app.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(seo.robotsTxt({ sitemaps: [`${config.baseUrl}/sitemap.xml`], disallow: discovery.ROBOTS_DISALLOW })
            + `# Agent manifest: ${config.baseUrl}/.well-known/agent.json\n`));
    const { sections: llmsSections, optional: llmsOptional } = discovery.llmsSections();
    app.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(seo.llmsTxt({ name: SITE_NAME, summary: discovery.SUMMARY, details: `${discovery.CONTENT_LABELS}\n\n${discovery.API_ROUTES}`, markdown: true, base: config.baseUrl, sections: llmsSections, optional: llmsOptional })));
    app.get('/llms-full.txt', wrap(async (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(seo.llmsFull({ site: SITE_NAME, summary: discovery.SUMMARY, base: config.baseUrl, sections: await discovery.llmsFullSections(), maxBytes: 512 * 1024 }))));
    // The sharing page people and agents are sent to (llms.txt's "Sharing a paste"): Markdown, one source. The .md
    // address is the twin llms.txt links; the page itself keeps answering text/plain for a browser.
    const docPage = (file) => (req, res) => res.type(req.path.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
        .set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(require('fs').readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8'));
    app.get(['/docs/sharing', '/docs/sharing.md'], docPage('sharing.md'));
    // Locked pastes (Locker design 2026-11-06): the format, the three locks and the agent path, one source.
    app.get(['/docs/locked-pastes', '/docs/locked-pastes.md'], docPage('locked-pastes.md'));
    app.get('/sitemap.xml', async (_req, res) => {
        let rows;
        try { rows = await discovery.sitemapRows(); } catch { return res.status(503).end(); }
        res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.sitemapXml(rows));
    });
    app.get('/feed.xml', wrap(async (_req, res) => res.type('application/rss+xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 900 }))
        .send(seo.feedXml({ title: `${SITE_NAME} — latest pastes`, link: `${config.baseUrl}/pastes`, description: DEFAULT_DESCRIPTION,
            language: 'en', selfUrl: `${config.baseUrl}/feed.xml`, items: await discovery.pasteFeedItems() }, { format: 'rss' }))));
    // GET /<key>.txt — the IndexNow key file (only when a key is configured; it serves itself).
    if (indexnow.enabled) app.use(indexnow.keyFile);
    // /.well-known/security.txt (RFC 9116, SEO-30). Contact, Expires and Canonical are required; Canonical is
    // this site's own, from the config, never a constant. Policy is listed only while
    // https://openvibe.network/security answers 200 (checked 2026-10-29). Expires is the date the file must be
    // refreshed by: one year on, a person re-reads and re-commits it.
    app.get('/.well-known/security.txt', (_req, res) => res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400')
        .send([
            'Contact: mailto:security@openvibe.network',
            `Expires: ${SECURITY_EXPIRES}`,
            'Preferred-Languages: en',
            `Canonical: ${config.baseUrl}/.well-known/security.txt`,
            'Policy: https://openvibe.network/security',
            '',
        ].join('\n')));

    // ── Pages ────────────────────────────────────────────────
    // Pages are for browsers: the viewer (subject, staff) is resolved here too.
    const withUser = viewers.middleware({ services: false });
    const ctxOf = (req) => ({ token: req.token, ip: req.ip, userAgent: req.get('user-agent') || '', viewer: req.viewer });
    const html = (res, body, status = 200) => {
        setRobotsHeader(res, body);
        return res.status(status).type('html').set('Cache-Control', PAGE_CACHE).send(body);
    };
    // A public page with a Markdown twin names it in the Link header and varies on Accept. Only the
    // pages the agent layer twins (the home, /pastes and a paste) call this.
    const twinLink = (res, pathname) => {
        res.vary('Accept');
        res.set('Link', require('openvibe-shared/agent-layer').linkHeaderTags(`${config.baseUrl}${pathname}`, `${config.baseUrl}/llms.txt`).header);
    };
    // Every page response below (redirects and error pages too) that sets no policy of its own.
    app.use(cache.applyHtml({ private: true }));

    // The home's other shelves: the forum's public places, the roadmap (its five next, in progress first), the network's
    // four latest from Pulse (pastes are shown above it already) and real counts. Read at most once a minute; a shelf
    // that fails or is empty is left out of the page.
    let homeExtras = { at: 0, value: null };
    async function readHomeExtras() {
        if (homeExtras.value && Date.now() - homeExtras.at < 60_000) return homeExtras.value;
        const quiet = (p, fallback) => Promise.resolve().then(() => p).catch(() => fallback);
        const [spaces, roadmap, roadmapCounts, activity, counts] = await Promise.all([
            quiet(require('./forum/store').listSpaces(db, ['public']), []),
            quiet(db.prepare(`SELECT t.title, t.slug, t.status, t.last_activity_at FROM threads t JOIN spaces s ON s.id = t.space_id
                WHERE s.slug = 'roadmap' AND s.visibility = 'public' AND t.deleted_at IS NULL AND t.members_only_owner IS NULL
                ORDER BY (t.status = 'in_progress') DESC, t.last_activity_at DESC, t.id DESC LIMIT 5`).all(), []),
            quiet(db.prepare(`SELECT t.status, COUNT(*) AS n FROM threads t JOIN spaces s ON s.id = t.space_id
                WHERE s.slug = 'roadmap' AND t.deleted_at IS NULL GROUP BY t.status`).all(), []),
            quiet(pulse.list({ limit: 16 }).then((out) => {
                // One row a place: a stream's go-live and the day's card that follows it link the same channel.
                const seen = new Set();
                return (out.items || []).filter((it) => it.source && it.source.type !== 'paste' && !seen.has(it.url) && seen.add(it.url)).slice(0, 5);
            }), []),
            quiet(db.prepare(`SELECT (SELECT COUNT(*) FROM pastes WHERE deleted_at IS NULL AND visibility = 'public') AS pastes,
                (SELECT COUNT(*) FROM pulse_items) AS pulse`).get(), {}),
        ]);
        const value = {
            spaces: spaces.filter((sp) => sp.slug !== 'roadmap' && !sp.members_only_owner),
            roadmap, activity,
            counts: {
                pastes: Number(counts.pastes) || 0, pulse: Number(counts.pulse) || 0,
                shipped: Number((roadmapCounts.find((r) => r.status === 'done') || {}).n) || 0,
                building: Number((roadmapCounts.find((r) => r.status === 'in_progress') || {}).n) || 0,
            },
        };
        homeExtras = { at: Date.now(), value };
        return value;
    }

    // The public pages the agent layer twins, built once here and used by both the HTML routes and
    // server/agent-pages.js. A twin passes the anonymous viewer and noView: it must never carry a
    // signed-in person's view, count a page view or consume a burn-after-read paste.
    async function homeView(user) {
        // People's pastes lead; OpenVibe.AI's moment pastes from streams have their own rail. The most viewed are a quick
        // filter there (/pastes?sort=views), not a shelf of their own.
        const [latest, fromStreams, languages, extras] = await Promise.all([catalog.latest(12, { from: 'people' }), catalog.latest(8, { from: 'streams' }), catalog.languages(), readHomeExtras()]);
        return pages.homePage({ latest, fromStreams, languages, user, ...extras });
    }

    async function browseView(query) {
        const [result, languages] = await Promise.all([catalog.browse(query), catalog.languages()]);
        return pages.browsePage(result, languages);
    }

    const agentViews = {
        home: () => homeView(null),
        browse: (query) => browseView(query),
        paste: (slug, query) => pasteView(slug, query, {
            viewer: ANONYMOUS, user: null, twin: true,
            ctx: { viewer: ANONYMOUS, noView: true, ip: '127.0.0.1', userAgent: '' },
        }),
    };

    // The agent layer (openvibe-shared/agent-layer): /.well-known/agent.json, and the Markdown twins of the
    // home, /pastes and a paste. Gated to the manifest and twin requests only, so a browser (signed in or
    // not) keeps the page its own route renders; the twins render through the same page builders signed out.
    {
        const agentRouter = express.Router();
        require('openvibe-shared/agent-layer').mount(agentRouter, {
            descriptor: require('./agent-descriptor'),
            render: require('./agent-pages').createAgentPages({ views: agentViews }).renderPublicPage,
        });
        // An old paste address's twin 301s to the canonical address's twin, exactly as the page does, so the
        // Markdown a crawler stores names one URL.
        app.use(async (req, res, next) => {
            if (!String(req.path || '').startsWith('/p/') || !String(req.path || '').endsWith('.md')) return next();
            let slug;
            try { slug = decodeURIComponent(req.path.slice(3, -3)); } catch { return next(); }
            const canonical = await require('./pastes/store').canonicalForRef(db, slug).catch(() => null);
            if (!canonical || canonical === slug) return next();
            const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(301, `/p/${encodeURIComponent(canonical)}.md${q}`);
        });
        app.use((req, res, next) => {
            // The manifest exactly: the rest of /.well-known/ (security.txt) belongs to the app.
            if (req.path === '/.well-known/agent.json') return agentRouter(req, res, next);
            if (String(req.path || '').endsWith('.md') || (req.query && req.query.format === 'markdown')
                || req.accepts(['html', 'text/markdown']) === 'text/markdown') return agentRouter(req, res, next);
            return next();
        });
    }

    app.get('/', withUser, wrap(async (req, res) => {
        twinLink(res, '/');
        html(res, await homeView(req.user));
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
        twinLink(res, req.originalUrl);
        html(res, await browseView(req.query));
    }));

    // Old Live-style /pastes/<slug> links and bare slugs land on the paste page.
    app.get('/pastes/:slug', (req, res) => res.redirect(301, `/p/${encodeURIComponent(req.params.slug)}`));

    // A paste link copied out of a chat or a document often carries what followed it: a full stop, a bracket, Markdown's
    // ** around it. Characters no slug can hold are dropped from its end with a redirect, not answered "Paste not found".
    app.get(/^\/p\/[^/]+(?:\/(?:raw|screenshot|download))?\/?$/, (req, res, next) => {
        const [, , raw, rest = ''] = req.path.match(/^\/(p)\/([^/]+)((?:\/[a-z]+)?)\/?$/) || [];
        let seg;
        try {
            seg = decodeURIComponent(raw || '');
        } catch {
            return next();
        }
        if (SLUG_RE.test(seg)) return next();
        const clean = seg.replace(/[^A-Za-z0-9_-]+$/, '');
        if (!SLUG_RE.test(clean)) return next();
        const q = req.originalUrl.indexOf('?');
        res.redirect(301, `/p/${clean}${rest}${q >= 0 ? req.originalUrl.slice(q) : ''}`);
    });

    /** The paste page's body, or the error page it answers with; the HTML route and the twin share it. */
    async function pasteView(slug, query, { viewer, user, ctx, twin = false } = {}) {
        if (!SLUG_RE.test(slug)) return { status: 404, body: pages.errorPage({ status: 404, title: 'Paste not found', message: 'That link does not point at a paste.' }) };
        // A twin is not a person reading: never consume a burn-after-read paste for one.
        if (twin) {
            let row = await db.prepare('SELECT burn_after_read FROM pastes WHERE slug = ?').get(slug);
            if (!row) {
                const id = require('./pastes/url').publicIdOfRef(slug);
                if (id) row = await db.prepare('SELECT burn_after_read FROM pastes WHERE public_id = ?').get(id);
            }
            if (!row || Number(row.burn_after_read)) return null;
        }
        let paste;
        try {
            paste = await source.getPaste(slug, ctx);
        } catch (err) {
            if (err.status === 404) {
                // A paste shared with specific people answers the gate: "Ask for access" when signed
                // in, "Sign in" otherwise, and never its title, content, screenshot or comments.
                const sh = await sharing.shareOf(await require('./pastes/store').canonicalForRef(db, slug) || slug);
                if (sh && sh.audience === 'people') {
                    const signInUrl = `/auth/login?next=${encodeURIComponent(`/p/${slug}`)}`;
                    return { status: 404, body: pages.gatePage({ slug, signedInAs: user && user.username ? user.username : null, signInUrl }) };
                }
                return { status: 404, body: pages.errorPage({ status: 404, title: 'Paste not found', message: 'It may have been deleted, burned after reading, or never existed.' }) };
            }
            if (err.status === 410) return { status: 410, body: pages.errorPage({ status: 410, title: 'This paste has burned', message: 'It was set to burn after reading, and it has been read.' }) };
            throw err;
        }
        const share = await app.locals.pastes.shareState(viewer, paste);
        const related = await catalog.related(paste, 6);
        // Its comments are the paste's typed thread (community/paste/<slug>), the one /c/:accessId and the
        // comments API show, sorted (?sort=old|new) and paged (?after=<last comment id>) as there; null while
        // nobody has commented. The comment service applies the paste's visibility again.
        // A burn-after-read paste is gone once shown, so it has no comment panel.
        const after = /^\d{1,15}$/.test(String(query.after || '')) ? String(query.after) : null;
        const sort = query.sort === 'old' ? 'old' : 'new';
        const thread = paste.burn_after_read ? null : await comments.forRef(viewer, pasteRef(paste.slug), { sort, after, limit: 30 });
        return {
            status: 200, slug: paste.slug, canonical: paste.canonical_slug || paste.slug,
            body: pages.pastePage({ paste, related, user, comments: thread, commentSort: sort, commentsAfter: after, share }),
        };
    }

    app.get('/p/:slug', withUser, wrap(async (req, res) => {
        // The id is the address; the title slug before it is decoration. An old adjective-noun-number slug, a
        // bare id or a title that has since changed all 301 to the one canonical form (query kept), before a
        // view is counted.
        const canonical = await require('./pastes/store').canonicalForRef(db, req.params.slug);
        if (canonical && canonical !== req.params.slug) {
            const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(301, `/p/${encodeURIComponent(canonical)}${q}`);
        }
        const out = await pasteView(req.params.slug, req.query, { viewer: req.viewer, user: req.user, ctx: ctxOf(req) });
        if (!out) return html(res, pages.errorPage({ status: 404, title: 'Paste not found', message: 'It may have been deleted, burned after reading, or never existed.' }), 404);
        if (out.status === 200) twinLink(res, `/p/${encodeURIComponent(out.canonical || out.slug)}`);
        html(res, out.body, out.status);
    }));

    // No-JS comment form: signed in, the cookie (SameSite=Lax) and no Origin from another site, as on /c/:accessId.
    // The thread opens on the first comment; the comment service decides the rest (visibility, lock, blocks, limits).
    app.post('/p/:slug/comments', withUser, express.urlencoded({ extended: false, limit: '64kb' }), wrap(async (req, res, next) => {
        const { slug } = req.params;
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
        let back = `/p/${encodeURIComponent(slug)}`;
        try {
            if (!SLUG_RE.test(slug)) throw new v1.ApiError(404, 'ref.not_found', 'No such paste');
            // The URL may be the canonical title+id form; the comment thread is keyed by the paste's stored
            // slug, so resolve the paste first and keep the stable ref.
            const found = await source.getPaste(slug, { ...ctxOf(req), noView: true });
            const stable = found.slug;
            back = `/p/${encodeURIComponent(found.canonical_slug || stable)}`;
            if (!req.viewer || !req.viewer.subject) return res.redirect(303, `/auth/login?next=${encodeURIComponent(back)}`);
            const { thread } = await comments.resolve(req.viewer, { ref: pasteRef(stable) });
            const b = req.body || {};
            const out = await comments.add(req.viewer, thread.id, { message: String(b.message || '').slice(0, 5000), parent_id: b.parent_id || null });
            return res.redirect(303, `${back}#comment-${out.comment.id}`);
        } catch (err) {
            if (!(err instanceof v1.ApiError) && !(err && err.name === 'PasteError')) return next(err);
            if (err.status === 401) return res.redirect(303, `/auth/login?next=${encodeURIComponent(back)}`);
            if (err.status === 404) return html(res, pages.errorPage({ status: 404, title: 'Paste not found', message: 'It may have been deleted, burned after reading, or never existed.' }), 404);
            return html(res, pages.errorPage({ status: err.status, title: err.status === 429 ? 'Slow down' : 'That did not work', message: err.message }), err.status);
        }
    }));

    // Raw text is served here, the screenshot link is the stored Media URL.
    const notFound = (res) => res.status(404).type('text/plain').set('X-Content-Type-Options', 'nosniff').send('Not found');
    app.get('/p/:slug/raw', withUser, async (req, res) => {
        if (!SLUG_RE.test(req.params.slug)) return notFound(res);
        try {
            const out = await app.locals.pastes.raw(req.viewer, req.params.slug, ctxOf(req));
            if (out.redirect) return res.redirect(302, out.redirect);
            res.set('X-Content-Type-Options', 'nosniff').set('Cache-Control', cache.htmlHeaders({ private: true }));
            // A locked paste's raw is its envelope, exactly as it was uploaded: `.ovlk`, never a text body.
            if (out.bytes) return res.type('application/octet-stream').set('Content-Disposition', `inline; filename="${out.filename}"`).send(out.bytes);
            res.type('text/plain; charset=utf-8').send(out.content);
        } catch (err) {
            if (err.status === 410) return res.status(410).type('text/plain').set('X-Content-Type-Options', 'nosniff').send('This paste has been burned after reading.');
            if (err.status === 404) return notFound(res);
            throw err;
        }
    });
    // The screenshot proxy: the one place a screenshot's bytes leave Community. The paste's share
    // check decides (canView, through screenshotUrl), then the bytes come from Media with Community's
    // token. The Media object's own URL is never handed to a browser.
    app.get('/p/:slug/screenshot', withUser, async (req, res) => {
        if (!SLUG_RE.test(req.params.slug)) return notFound(res);
        const variant = screenshotVariant(req.query);
        if (variant && variant.error) return res.status(400).type('text/plain').set('X-Content-Type-Options', 'nosniff').send(variant.error);
        try {
            await app.locals.pastes.screenshotUrl(req.viewer, req.params.slug);
            const row = await db.prepare('SELECT media_ref, screenshot_url, visibility, burn_after_read, locked FROM pastes WHERE (slug = ? OR public_id = ?) AND deleted_at IS NULL').get(req.params.slug, require('./pastes/url').publicIdOfRef(req.params.slug) || '');
            const got = row ? await app.locals.pasteMedia.bytes(row, variant) : null;
            if (!got) return notFound(res);
            // A public paste's screenshot never changes under this URL, so it is cached like any other
            // content-addressed asset: the home page shows six of them and each is several hundred KB,
            // and re-downloading every one on every visit was most of the home page's 4 MB. Anything
            // whose audience is a person (private, burn-after-read, locked) stays private and uncached.
            const shared = row.visibility === 'public' && !Number(row.burn_after_read) && !row.locked;
            res.set('X-Content-Type-Options', 'nosniff')
                .set('Cache-Control', shared ? cache.assetHeaders('screenshot.png', { hashed: true }) : cache.htmlHeaders({ private: true }));
            res.type(got.type || 'application/octet-stream').send(got.body);
        } catch (err) {
            if (err.status === 410) return res.status(410).type('text/plain').set('X-Content-Type-Options', 'nosniff').send('This paste has been burned after reading.');
            if (err.status === 404) return notFound(res);
            throw err;
        }
    });

    app.get('/p/:slug/download', withUser, wrap(async (req, res) => {
        const { slug } = req.params;
        if (!SLUG_RE.test(slug)) return res.status(404).type('text/plain').send('Not found');
        let paste;
        try { paste = await source.getPaste(slug, { ...ctxOf(req), noView: true }); }
        catch (err) { if (err.status === 404 || err.status === 410) return res.status(err.status).type('text/plain').send('Not found'); throw err; }
        if (paste.locked) {
            try {
                const out = await app.locals.pastes.envelope(req.viewer, slug);
                return res.set('Cache-Control', cache.htmlHeaders({ private: true }))
                    .set('Content-Disposition', `attachment; filename="${out.filename}"`)
                    .type('application/octet-stream').send(out.bytes);
            } catch (err) { if (err.status === 404) return res.status(404).type('text/plain').send('Not found'); throw err; }
        }
        if (paste.type === 'screenshot') return res.redirect(302, `/p/${encodeURIComponent(paste.canonical_slug || slug)}/screenshot`);
        res.set('Content-Disposition', `attachment; filename="${slug}.${extensionFor(paste.language)}"`);
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        res.type('text/plain; charset=utf-8').send(String(paste.content || ''));
    }));

    app.get('/new', withUser, wrap(async (req, res) => {
        let fork = null;
        if (req.query.fork && SLUG_RE.test(String(req.query.fork))) {
            try { const p = await source.getPaste(String(req.query.fork), { ...ctxOf(req), noView: true }); if (p && p.type === 'paste') fork = p; } catch { /* no fork, plain form */ }
        }
        html(res, pages.newPage({ user: req.user, fork }));
    }));

    // No-JS fallback: a plain form post becomes the same JSON create the API path uses, under the
    // same anonymous-write budget.
    app.post('/new', withUser, anonWriteLimiter, express.urlencoded({ extended: false, limit: '1mb' }), wrap(async (req, res) => {
        const b = req.body || {};
        // Same-site-only, like every other no-JS form post: SameSite=Lax already keeps the cookie off a
        // cross-site POST, but a forged post would still create an anonymous paste (spam).
        const origin = req.get('origin');
        if (origin && origin !== 'null' && origin !== config.baseUrl) return html(res, pages.errorPage({ status: 403, title: 'Not allowed', message: 'That form was sent from another site.' }), 403);
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
    app.use(createSubmissionPages({ submissions, viewers, config }));
    app.get('/pulse', viewers.middleware({ services: false }), wrap(async (req, res) => {
        const origin = pulse.ORIGINS.includes(req.query.origin) ? req.query.origin : '';
        let out;
        try { out = await pulse.list({ origin, after: req.query.after }); }
        catch (err) { if (err instanceof v1.ApiError) return res.redirect(302, origin ? `/pulse?origin=${origin}` : '/pulse'); throw err; }
        html(res, pulsePage({ items: out.items, origin, after: req.query.after || null, nextCursor: out.next_cursor, origins: await pulse.origins() }));
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
        console.error('[App]', err && err.stack ? err.stack : err);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal error' });
        html(res, pages.errorPage({ status: 500, title: 'Something went wrong', message: 'This one is on us. Please try again.' }), 500);
    });

    return app;
}

/** Async route wrapper — rejections reach the error handler. */
function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

module.exports = { createApp };
