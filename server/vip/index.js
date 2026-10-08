'use strict';

/**
 * Community's seam to OpenVibe.VIP: members-only forum spaces and threads.
 *
 *   gate.check({ subject, type: 'space'|'thread', id, owner }) → { allow, reason }
 *       POST /api/v1/policies/evaluate through the product cache (createVipCache), with the owner
 *       Community stored on the row and the product's default gate
 *       { requirement: 'member', binding: 'community:members_only' } — the creator's own VIP rule for
 *       the resource, if they set one, wins. The owner passes without asking VIP.
 *   gate.joinUrl(owner, username) → the creator's page on openvibe.vip
 *   gate.cache                      invalidate / handleEvent (vip.membership.changed, …) / clear
 *
 * Convergence: Community has no Events inbox, so a cached "yes" outlives VIP's "no" by at most
 * config.vip.ttlMs (30 s by default); see OpenVibe.VIP's README for the end-to-end bound.
 * Fails closed: no client secret, VIP down, a refused token or a malformed answer is a "no".
 */
const { serviceAuth, ids } = require('openvibe-contracts');
const { createVipClient, createVipCache } = require('./vip-client');

const FALLBACK = Object.freeze({ requirement: 'member', binding: 'community:members_only' });

function createVipGate({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const vipConfig = config.vip || {};
    const secret = config.oauth && config.oauth.clientSecret;
    const tokenClient = secret ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: secret,
        audience: 'openvibe.vip',
        scope: 'vip.resource.policy.evaluate',
        fetchImpl,
    }) : null;
    const client = createVipClient({
        baseUrl: vipConfig.internalUrl || 'http://127.0.0.1:4620',
        tokenClient,
        getToken: tokenClient ? null : async () => { throw new Error('OV_OAUTH_CLIENT_SECRET is not set'); },
        fetch: fetchImpl,
        timeoutMs: vipConfig.timeoutMs || 2000,
        log,
    });
    const cache = createVipCache({
        vip: client,
        ttlMs: vipConfig.ttlMs || 30_000,
        denyTtlMs: vipConfig.denyTtlMs || 10_000,
        unavailableTtlMs: vipConfig.unavailableTtlMs || 2_000,
        now,
    });

    async function check({ subject, type, id, owner }) {
        if (!owner) return { allow: true, reason: 'open' };
        if (subject && subject === owner) return { allow: true, reason: 'owner' };
        if (!subject) return { allow: false, reason: 'not_signed_in' };
        const d = await cache.evaluate({ subject, resource: { service: 'community', type, id: String(id) }, owner, fallback: FALLBACK });
        return { allow: d.allow === true, reason: d.reason || (d.allow === true ? 'member' : 'denied') };
    }

    const base = (vipConfig.publicUrl || 'https://openvibe.vip').replace(/\/$/, '');
    const joinUrl = (owner, username) => `${base}/${encodeURIComponent(username || owner)}`;

    return { check, joinUrl, cache, client, FALLBACK, bounds: cache.bounds };
}

const isUserSubject = (s) => typeof s === 'string' && ids.isSubjectId('user', s);

module.exports = { createVipGate, isUserSubject, FALLBACK };
