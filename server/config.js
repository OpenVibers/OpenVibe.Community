'use strict';

require('dotenv').config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

const port = parseInt(process.env.PORT, 10) || 4200;

module.exports = {
    port,
    host: process.env.HOST || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,

    // Public URL of this site — canonical links, OG tags, sitemap entries.
    baseUrl: (process.env.BASE_URL || (isProduction ? 'https://openvibe.community' : `http://localhost:${port}`)).replace(/\/$/, ''),

    // Hops in front of Node that set X-Forwarded-For: Cloudflare → nginx → Node.
    trustProxy: process.env.TRUST_PROXY != null ? Number(process.env.TRUST_PROXY) : 2,

    // Per-actor limits at the API routes (server/actor-limits.js, roadmap WS-R task 4): the reads one
    // caller may make to one API per minute and per hour. Writes set their own numbers per route.
    limits: {
        minute: parseInt(process.env.COMMUNITY_LIMITS_MINUTE, 10) || 120,
        hour: parseInt(process.env.COMMUNITY_LIMITS_HOUR, 10) || 3000,
    },

    // Identity provider — OpenVibe.Network (OAuth2 authorization server + JWKS)
    networkUrl: (process.env.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/$/, ''),
    networkInternalUrl: (process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/$/, ''),

    // OAuth2 client credentials (client `community` registered in the Network's oauth_clients table)
    oauth: {
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'community',
        clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '',
        redirectUri: process.env.OV_OAUTH_REDIRECT_URI
            || (isProduction ? 'https://openvibe.community/auth/callback' : 'http://localhost:4200/auth/callback'),
        scope: 'profile theme',
    },

    // Cookies are host-only for openvibe.community (no Domain attribute — there are no subdomains).
    cookies: {
        secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    },

    // OpenVibe.Search's query API (the /search page), asked anonymously: public documents only.
    searchInternalUrl: (process.env.OV_SEARCH_INTERNAL_URL || 'http://127.0.0.1:4710').replace(/\/$/, ''),
    liveUrl: (process.env.OV_LIVE_URL || 'https://openvibe.live').replace(/\/$/, ''),
    // OpenVibe.Media — public host that serves raw paste text and screenshots.
    mediaUrl: (process.env.OV_MEDIA_URL || 'https://openvibe.media').replace(/\/$/, ''),
    // Media's internal address: new screenshot uploads go to its file store (community app).
    mediaInternalUrl: (process.env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100').replace(/\/$/, ''),

    // PostgreSQL (ADR-035) for Community's own data: pastes (Community is their only authority),
    // comments, Pulse and submissions. DATABASE_URL serves (PgBouncer);
    // DATABASE_DIRECT_URL migrates (owner). Without them,
    // development uses an embedded PGlite database in data/pglite.
    db: { url: process.env.DATABASE_URL || '', directUrl: process.env.DATABASE_DIRECT_URL || '' },
    // Valkey (ADR-035): per-actor limit counters shared across processes; without it they count in this process.
    valkey: { url: process.env.VALKEY_URL || '', prefix: process.env.VALKEY_PREFIX || 'ov:community:' },

    // Browser origins allowed to call the embeddable APIs (/api/v1/comments, /api/v1/pulse)
    // with a Bearer Network JWT. No cookies cross origins.
    apiCorsOrigins: (process.env.API_CORS_ORIGINS || 'https://openvibe.live,https://openvibe.media,https://openvibe.network,https://openvibe.tools,https://openvibe.games')
        .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),

    // IndexNow (openvibe-shared/indexnow): when INDEXNOW_KEY is set, the key file is served at
    // /<key>.txt and a public, indexable page appearing, changing or going away pings the engines.
    // Unset: off — nothing is mounted and nothing is sent.
    indexnow: { key: process.env.INDEXNOW_KEY || '' },

};
