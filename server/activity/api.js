'use strict';

/**
 * GET /api/v1/activity — Community's public activity for the one feed (OpenVibe.Network server/feed/).
 * Read-only and public: only public rows, capped, newest first. It is the site's own public API, not a
 * second Pulse: nothing is stored, and the feed polls it on a due basis.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run } = require('../http/v1');

const CACHE_MS = 30_000;
// The suite reads a paste it just made (and a thread it just gated): no cache in tests, 30 s in production.
const cacheMs = () => (process.env.NODE_ENV === 'test' ? 0 : CACHE_MS);

function createActivityApi({ activity, viewers, limits }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    router.use(limits.reads('community.feed.read'));
    let cache = { at: 0, key: '', body: null };
    router.get('/', run(async (req) => {
        const since = String(req.query.since || '');
        const limit = String(req.query.limit || '500');
        const key = `${since}|${limit}`;
        if (cache.body && cache.key === key && Date.now() - cache.at < cacheMs()) return cache.body;
        const items = await activity.list({ since: /^\d{4}-\d{2}-\d{2}T/.test(since) ? since : null, limit });
        const body = { items, count: items.length };
        cache = { at: Date.now(), key, body };
        return body;
    }));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createActivityApi };
