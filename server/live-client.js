'use strict';

/**
 * OpenVibe.Live client — server-side reads of the paste API for rendered pages.
 *
 * Everything paste-shaped goes through Live's /api/pastes/* (see config.liveInternalUrl for
 * why). The visitor's Network JWT and real client address are forwarded on every call, so a
 * signed-in visitor sees their own private/unlisted pastes and Live's per-address rate limits
 * and view counting see the visitor, not this proxy.
 */
const config = require('./config');

class LiveApiError extends Error {
    constructor(status, body) {
        super((body && body.error) || `Live API ${status}`);
        this.name = 'LiveApiError';
        this.status = status;
        this.body = body;
    }
}

function _qs(query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
    }
    const s = params.toString();
    return s ? `?${s}` : '';
}

/**
 * @param {string} apiPath  e.g. '/pastes?limit=10' (relative to /api)
 * @param {object} [opts]   { method, query, body, token, ip, timeoutMs }
 */
async function request(apiPath, { method = 'GET', query, body, token, ip, timeoutMs = 10_000 } = {}) {
    const url = `${config.liveInternalUrl}/api${apiPath}${_qs(query)}`;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ip) headers['X-Forwarded-For'] = ip;
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    let res, text;
    try {
        res = await fetch(url, opts);
        text = await res.text();
    } catch (err) {
        // Unreachable / timed out: surface as an upstream error so pages show the outage
        // message instead of a generic 500.
        throw new LiveApiError(503, { error: err.name === 'TimeoutError' ? 'Paste service timed out' : 'Paste service unreachable' });
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new LiveApiError(res.status, data);
    return data;
}

// ── Pastes ───────────────────────────────────────────────────
/** Public listing: { pastes, total, limit, offset }. */
function listPastes(query, ctx = {}) {
    return request('/pastes', { query, token: ctx.token, ip: ctx.ip });
}

/** One paste (counts a view unless noView). Throws LiveApiError(404) when unknown/private. */
async function getPaste(slug, ctx = {}) {
    const out = await request(`/pastes/${encodeURIComponent(slug)}`, {
        query: ctx.noView ? { no_view: 1 } : undefined, token: ctx.token, ip: ctx.ip,
    });
    return out && out.paste ? out.paste : out;
}

/** A user's pastes ({ pastes, total, username }); the owner also gets unlisted/private ones. */
function listByUser(username, query, ctx = {}) {
    return request(`/pastes/by-user/${encodeURIComponent(username)}`, { query, token: ctx.token, ip: ctx.ip });
}

/** Create a text paste on the visitor's behalf (no-JS form fallback). */
function createPaste(body, ctx = {}) {
    return request('/pastes', { method: 'POST', body, token: ctx.token, ip: ctx.ip, timeoutMs: 20_000 });
}

// ── Public URL builders (OpenVibe.Media serves the bytes) ────
function rawUrl(slug) { return `${config.mediaUrl}/p/${encodeURIComponent(slug)}/raw`; }
function screenshotUrl(slug) { return `${config.mediaUrl}/p/${encodeURIComponent(slug)}/screenshot`; }
/** Absolute-ize a Media-relative URL (screenshot_url from the API). */
function mediaPublicUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return `${config.mediaUrl}${u.startsWith('/') ? '' : '/'}${u}`;
}

module.exports = { LiveApiError, request, listPastes, getPaste, listByUser, createPaste, rawUrl, screenshotUrl, mediaPublicUrl };
