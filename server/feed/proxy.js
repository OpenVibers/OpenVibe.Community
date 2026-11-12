'use strict';

/**
 * GET /api/v1/feed — the menu's Feed on every OpenVibe site, read from Network (feed.item@1).
 *
 * Network owns the one feed (server/feed/api.js there): it reads Events and the sites' public APIs,
 * ranks For you / Following and applies the privacy rules. Community answers the same path by asking
 * it, forwarding the person's own session token and nothing else, so Pulse and the menu show the same
 * items and the same ids. Pulse's own collector is gone (server/pulse/sources.js, consumer.js).
 *
 * A Network outage answers an empty page, never an error: the menu's Feed is not a reason to fail a
 * Community page.
 */
const express = require('express');
const { run } = require('../http/v1');
const { extractToken } = require('../auth/routes');

const PASS = ['kind', 'site', 'q', 'following', 'cursor', 'limit'];

function createFeedProxy({ config, fetchImpl = globalThis.fetch }) {
    const base = String(config.networkInternalUrl || config.networkUrl || 'https://openvibe.network').replace(/\/+$/, '');
    const publicCache = new Map();

    async function read(path, params, token) {
        const u = new URL(path, base);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
        const key = `${path}?${u.searchParams}`;
        if (!token) {
            const kept = publicCache.get(key);
            if (kept && Date.now() - kept.at < 30_000) return { status: 200, body: kept.body, cached: true };
        }
        try {
            const r = await fetchImpl(u.href, { headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8000) });
            const text = await r.text();
            if (!r.ok) throw new Error(`Network answered ${r.status}`);
            let body;
            try { body = JSON.parse(text); } catch { throw new Error('Network answered no JSON'); }
            if (!token) {
                if (publicCache.size >= 300) publicCache.clear();
                publicCache.set(key, { at: Date.now(), body });
            }
            return { status: 200, body, cached: false };
        } catch {
            if (path === '/api/v1/feed/examples') return { status: 200, body: { examples: [] }, cached: false };
            if (path === '/api/v1/feed/wall') return { status: 200, body: { items: [], next_cursor: null }, cached: false };
            return { status: 200, body: { items: [], next_cursor: null }, cached: false };
        }
    }

    async function relay(req, path, params) {
        return await read(path, params, extractToken(req));
    }

    function send(res, out, token) {
        res.set({
            'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization', Vary: 'Authorization',
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': token ? 'private, no-store' : 'public, max-age=30',
            'X-Feed-Source': 'network',
        });
        return res.json(out.body);
    }

    const router = express.Router();
    router.get('/', run(async (req, res) => {
        const params = {};
        for (const k of PASS) if (req.query[k] !== undefined) params[k] = String(req.query[k]).slice(0, 300);
        send(res, await relay(req, '/api/v1/feed', params), extractToken(req));
    }));
    router.get('/search', run(async (req, res) => {
        send(res, await relay(req, '/api/v1/feed/search', { q: String(req.query.q || '').slice(0, 80) }), extractToken(req));
    }));
    router.get('/examples', run(async (req, res) => {
        send(res, await relay(req, '/api/v1/feed/examples', {}), extractToken(req));
    }));
    router.get('/wall', run(async (req, res) => {
        send(res, await relay(req, '/api/v1/feed/wall', {
            limit: String(req.query.limit || '20').slice(0, 10),
            cursor: String(req.query.cursor || req.query.after || '').slice(0, 300),
        }), extractToken(req));
    }));
    return { router, read };
}

module.exports = { createFeedProxy };
