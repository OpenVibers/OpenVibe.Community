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

    // OpenVibe.Live — backs every paste read and write. The pastes themselves are stored in
    // OpenVibe.Media, but we go through Live rather than straight to Media: Live owns the
    // accounts these pastes belong to, so it is the only service that can turn a signed-in
    // visitor (a Network JWT) into the user id Media files the write under.
    liveInternalUrl: (process.env.OV_LIVE_INTERNAL_URL || 'http://127.0.0.1:3000').replace(/\/$/, ''),
    // OpenVibe.Search's query API (the /search page), asked anonymously: public documents only.
    searchInternalUrl: (process.env.OV_SEARCH_INTERNAL_URL || 'http://127.0.0.1:4710').replace(/\/$/, ''),
    liveUrl: (process.env.OV_LIVE_URL || 'https://openvibe.live').replace(/\/$/, ''),
    // OpenVibe.Media — public host that serves raw paste text and screenshots.
    mediaUrl: (process.env.OV_MEDIA_URL || 'https://openvibe.media').replace(/\/$/, ''),
    // Media's internal address: new screenshot uploads go to its file store (community app).
    mediaInternalUrl: (process.env.OV_MEDIA_INTERNAL_URL || 'http://127.0.0.1:4100').replace(/\/$/, ''),

    // Who answers /api/pastes/* and the paste pages:
    //   'live'      — proxy to OpenVibe.Live (which stores in Media). The default until cutover.
    //   'community' — this site's own database is the authority (server/pastes/api.js).
    pastesAuthority: process.env.PASTES_AUTHORITY === 'community' ? 'community' : 'live',
    // SQLite file for Community's own data: comments, the forum, Pulse, the relay's bookkeeping,
    // and pastes once authority=community.
    dbPath: process.env.COMMUNITY_DB_PATH || './data/community.db',

    // Browser origins allowed to call the embeddable APIs (/api/v1/comments, /api/v1/pulse)
    // with a Bearer Network JWT. No cookies cross origins.
    apiCorsOrigins: (process.env.API_CORS_ORIGINS || 'https://openvibe.live,https://openvibe.media,https://openvibe.network,https://openvibe.tools,https://openvibe.games')
        .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),

    // OpenVibe.VIP — members-only spaces and threads (forum/service.js). Every answer comes from
    // VIP's POST /api/v1/policies/evaluate (capability vip.resource.policy.evaluate, client
    // credentials of client `community`), cached per viewer: a "yes" at most ttlMs (the convergence
    // bound after VIP stops granting), a "no" denyTtlMs, a failure unavailableTtlMs. Without a
    // client secret or with VIP down, nobody but the owner and discussion moderators gets in.
    vip: {
        internalUrl: (process.env.OV_VIP_INTERNAL_URL || 'http://127.0.0.1:4620').replace(/\/$/, ''),
        publicUrl: (process.env.OV_VIP_URL || 'https://openvibe.vip').replace(/\/$/, ''),
        timeoutMs: parseInt(process.env.VIP_TIMEOUT_MS, 10) || 2000,
        ttlMs: parseInt(process.env.VIP_CACHE_TTL_MS, 10) || 30_000,
        denyTtlMs: parseInt(process.env.VIP_CACHE_DENY_TTL_MS, 10) || 10_000,
        unavailableTtlMs: parseInt(process.env.VIP_CACHE_UNAVAILABLE_TTL_MS, 10) || 2_000,
    },

    // Discord relay (server/relay; docs/discord-relay.md). Off by default, and inert without an owner's
    // webhook variables, mappings and (for inbound) bot token.
    //   out  threads and replies in mapped public spaces → the mapping's Discord webhook; edits and deletes follow
    //   in   replies on Discord → posts (the gateway; DISCORD_RELAY_INBOUND=on and DISCORD_BOT_TOKEN)
    // Webhook URLs live in environment variables named by relay_mappings.webhook_url_ref.
    discordRelay: {
        enabled: /^(1|true|yes|on)$/i.test(process.env.DISCORD_RELAY_ENABLED || ''),
        pollMs: parseInt(process.env.DISCORD_RELAY_POLL_MS, 10) || 30_000,
        backoffMs: parseInt(process.env.DISCORD_RELAY_BACKOFF_MS, 10) || 30_000,
        maxAttempts: parseInt(process.env.DISCORD_RELAY_MAX_ATTEMPTS, 10) || 6,
        // The only variables a mapping may name (comma-separated exact names); unset = DISCORD_WEBHOOK_*.
        webhookVars: (process.env.DISCORD_RELAY_WEBHOOK_VARS || '').split(',').map((s) => s.trim()).filter(Boolean),
        // The Events worker queues creates from community.thread.* / community.post.* (needs EVENTS_URL and
        // OV_OAUTH_CLIENT_SECRET, capability events.event.read); 'off' leaves them to the forum.
        events: !/^(0|false|no|off)$/i.test(process.env.DISCORD_RELAY_EVENTS || ''),
        eventsUrl: (process.env.EVENTS_URL || '').replace(/\/+$/, '') || null,
        eventsPollMs: parseInt(process.env.DISCORD_RELAY_EVENTS_POLL_MS, 10) || 5000,
        // Inbound through the Discord gateway (a bot in the server with the MESSAGE CONTENT intent).
        inbound: /^(1|true|yes|on)$/i.test(process.env.DISCORD_RELAY_INBOUND || ''),
        botToken: process.env.DISCORD_BOT_TOKEN || '',
        gatewayUrl: process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json',
        inboundPerMinute: parseInt(process.env.DISCORD_RELAY_INBOUND_PER_MINUTE, 10) || 6,
        inboundMaxChars: parseInt(process.env.DISCORD_RELAY_INBOUND_MAX_CHARS, 10) || 4000,
    },
};
