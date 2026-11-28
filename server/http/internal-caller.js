'use strict';
/**
 * A request another OpenVibe service sent straight to this process (its internal URL, on this machine), not one that
 * came through nginx. nginx sets X-Forwarded-For on every proxied request (from $remote_addr, never the client's own
 * header), and this process listens on the machine only, so a call with no X-Forwarded-For from a loopback address can
 * only be a neighbour service. Such calls are not counted in the per-address /api/ limit (11-28: every service on the
 * machine shared one 120-a-minute bucket, and a crawler walking OpenVibe.Deals' offers starved Deals' comment reads:
 * "Community answered 429"). The routes' own limits still apply.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isInternalCaller(req) {
    if (!req || !req.headers || req.headers['x-forwarded-for']) return false;
    const addr = (req.socket && req.socket.remoteAddress) || '';
    return LOOPBACK.has(addr);
}

module.exports = { isInternalCaller, LOOPBACK };
