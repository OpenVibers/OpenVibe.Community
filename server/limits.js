'use strict';

/**
 * Per-person write limits for comments and the forum (in memory, per process — the same model
 * as the paste service's comment limits). Keyed by the acting subject, so a person is limited
 * the same whether they write from a browser or through a service naming them in X-OV-Subject.
 *
 *   cooldownSec   minimum gap between two writes
 *   perMinute     writes per rolling minute
 *   duplicate     refuse the same text twice in a row
 *
 * Anonymous writes are limited per address by the app's shared anonymous-write limiter instead.
 */
const { ApiError } = require('./http/v1');

function createPersonLimiter({ cooldownSec = 0, perMinute = 0, duplicate = true, noun = 'posts' } = {}) {
    const recent = new Map(); // subject → [{ at, text }] newest first

    function list(key, now) {
        const l = (recent.get(key) || []).filter((e) => now - e.at < 60_000);
        recent.set(key, l);
        return l;
    }

    /** Throws a 429/400 ApiError when this write would go over; call record() after it succeeds. */
    function check(key, text = null) {
        if (!key) return;
        const now = Date.now();
        const l = list(key, now);
        if (cooldownSec > 0 && l.length && now - l[0].at < cooldownSec * 1000) {
            const wait = Math.ceil((cooldownSec * 1000 - (now - l[0].at)) / 1000);
            throw new ApiError(429, 'request.rate_limited', `Please wait ${wait}s before writing again`, { retry_after: wait });
        }
        if (perMinute > 0 && l.length >= perMinute) {
            throw new ApiError(429, 'request.rate_limited', `Too many ${noun}. Please slow down.`, { retry_after: Math.ceil((60_000 - (now - l[l.length - 1].at)) / 1000) });
        }
        if (duplicate && text != null && l.length && l[0].text === text) throw new ApiError(400, 'request.duplicate', 'Duplicate — you just posted that');
    }

    function record(key, text = null) {
        if (!key) return;
        const l = recent.get(key) || [];
        l.unshift({ at: Date.now(), text });
        recent.set(key, l.slice(0, Math.max(perMinute, 1) + 1));
    }

    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [k, l] of recent) if (!l.length || now - l[0].at > 120_000) recent.delete(k);
    }, 10 * 60_000);
    if (sweep.unref) sweep.unref();

    return { check, record };
}

module.exports = { createPersonLimiter };
