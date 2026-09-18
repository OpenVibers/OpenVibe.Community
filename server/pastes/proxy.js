'use strict';

/**
 * /api/pastes/* → OpenVibe.Live /api/pastes/* (transparent, server-side)
 *
 * The browser talks to /api/pastes/* on this site; we proxy to the same API the streaming
 * site's own paste pages use. This deliberately does NOT call Media's tenant API directly:
 * the visitor's JWT names the account by its NETWORK id, while the user_id Media stores for
 * these pastes is Live's own — different numbers for the same person, so a write filed here
 * straight into Media would land under whichever unrelated Live account holds that number.
 * Live resolves the visitor against its own accounts before writing, which only Live can do,
 * and this inherits its author names, anonymous-post limits and permission checks rather
 * than reimplementing them.
 *
 * Mounted BEFORE the body parsers: the request body is streamed upstream byte-for-byte
 * (JSON, multipart screenshot uploads, anything), with the visitor's token as a Bearer header
 * and the real client address in X-Forwarded-For.
 */
const config = require('../config');
const { extractToken } = require('../auth/routes');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization', 'content-length']);
const BODYLESS = new Set(['GET', 'HEAD', 'OPTIONS']);

function createPastesProxy(opts = {}) {
    const upstreamBase = () => `${opts.liveUrl || config.liveInternalUrl}/api/pastes`;

    return async function pastesProxy(req, res) {
        const target = `${upstreamBase()}${req.url === '/' ? '' : req.url}`;
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
            if (HOP_BY_HOP.has(k) || v == null) continue;
            headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        // Forward the visitor's JWT — Live verifies it and maps it to a local account.
        const userToken = extractToken(req);
        if (userToken) headers.authorization = `Bearer ${userToken}`;
        // Live rate-limits, bans and counts views by client address. Without this every visitor
        // arriving through this site would share one bucket and one identity.
        if (req.ip) headers['x-forwarded-for'] = req.ip;
        headers['x-forwarded-host'] = req.get('host') || '';
        headers.accept = req.get('accept') || 'application/json';

        const fetchOpts = { method: req.method, headers, redirect: 'manual' };
        if (!BODYLESS.has(req.method)) {
            if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
            fetchOpts.body = req;      // stream the body through untouched
            fetchOpts.duplex = 'half';
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), BODYLESS.has(req.method) ? 20_000 : 120_000);
        fetchOpts.signal = ctrl.signal;
        const onClientGone = () => { try { ctrl.abort(); } catch { /* */ } };
        res.on('close', onClientGone);

        try {
            const upstream = await fetch(target, fetchOpts);
            res.status(upstream.status);
            for (const [k, v] of upstream.headers) {
                if (k === 'content-type' || k === 'cache-control' || k === 'location' || k === 'retry-after'
                    || k === 'ratelimit-limit' || k === 'ratelimit-remaining' || k === 'ratelimit-reset') {
                    res.setHeader(k, v);
                }
            }
            const raw = Buffer.from(await upstream.arrayBuffer());
            res.send(raw);
        } catch (err) {
            if (!res.headersSent) {
                console.warn('[PasteProxy]', err.name === 'AbortError' ? 'upstream timed out' : err.message);
                res.status(502).json({ error: 'Could not reach the paste service' });
            }
        } finally {
            clearTimeout(timer);
            res.off('close', onClientGone);
        }
    };
}

module.exports = { createPastesProxy };
