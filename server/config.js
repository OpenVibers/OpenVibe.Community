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
    liveUrl: (process.env.OV_LIVE_URL || 'https://openvibe.live').replace(/\/$/, ''),
    // OpenVibe.Media — public host that serves raw paste text and screenshots.
    mediaUrl: (process.env.OV_MEDIA_URL || 'https://openvibe.media').replace(/\/$/, ''),
};
