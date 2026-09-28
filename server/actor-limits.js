'use strict';

/**
 * Per-actor rate limits at the API routes (roadmap WS-R task 4; openvibe-sdk/limits).
 *
 * The per-address /api/ limit (app.js) and the per-person content limits (limits.js: cooldowns, writes
 * a minute) stay. These count requests by who makes them, once req.viewer is resolved:
 *
 *   a person                        user:usr_… (their own token, or named by a service or app in X-OV-Subject)
 *   a first-party service relaying  ip:<address> of the signed-out visitor it forwards (X-Forwarded-For),
 *     a signed-out visitor          as the per-address limit counts them
 *   a service or app acting as      its principal (svc:live, app:app_…): moderation, AI output, Pulse ingest
 *     itself
 *   a signed-out browser            ip:<address>
 *
 * A first-party service reading for itself (no person, no visitor) is not counted on reads: its pages
 * speak for all its visitors, and the per-address /api/ limit already bounds it. Past a limit the route
 * answers 429 problem+json `rate_limited` with Retry-After before it does any work; the refusal is
 * logged once and counted in community_rate_limited_total{limit,window}. Reads get COMMUNITY_LIMITS_MINUTE
 * / COMMUNITY_LIMITS_HOUR (120 and 3000); writes set their own numbers where they are mounted. Counters
 * live in this process: a restart forgets them.
 *
 * Never limited: /api/health, /api/ready, /release.json, /metrics, and the signed Events deliveries
 * (/internal/events: Events pushes at its own pace, and a 429 would only make it retry and fall behind;
 * they also carry token cutoffs and account deletions). Pages keep their per-address form limits.
 */
const { createActorLimiter, defaultActor } = require('openvibe-sdk/limits');
const config = require('./config');

const FIRST_PARTY = /^svc:/;
const LOOPBACK = /^(::1$|127\.|::ffff:127\.)/;

/** A first-party service that forwards the address of the visitor it acts for. */
function relaysVisitor(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && FIRST_PARTY.test(String(v.service)) && req.get('x-forwarded-for') && req.ip && !LOOPBACK.test(req.ip));
}

function actor(req) {
    const v = req.viewer;
    if (!v || v.kind === 'anonymous') return defaultActor(req);
    if (v.subject) return `user:${v.subject}`;
    if (v.kind === 'service') return relaysVisitor(req) ? `ip:${req.ip}` : v.service;
    return defaultActor(req);
}

/** A first-party service reading for itself: no person, no visitor. */
function serviceItself(req) {
    const v = req.viewer;
    return !!(v && v.kind === 'service' && !v.subject && FIRST_PARTY.test(String(v.service)) && !relaysVisitor(req));
}

/**
 * limits(name, own) middleware for one app, plus limits.reads(name): the defaults on every GET/HEAD of
 * a router (its writes set their own limits per route). opts.limits and opts.now are for tests.
 */
function createActorLimits({ limits = null, now = () => Date.now(), registry = null, log = console } = {}) {
    const refused = registry
        ? registry.counter({ name: 'community_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: limits || { minute: config.limits.minute, hour: config.limits.hour },
        actor,
        now,
        onLimited(e) {
            // The actor is a subject id, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && !serviceItself(req) ? limit(req, res, next) : next());
    };
    return limiter;
}

module.exports = { createActorLimits, actor, serviceItself };
