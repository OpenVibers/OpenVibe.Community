'use strict';
/**
 * Community's control API for person-owned pastes (ADR-048 amendment 2026-10-15, step 8 phase 2; capability
 * community.resource.control): POST /api/v1/resources/control takes one common.owned-resource-control-request@1 from a
 * first-party service (OpenVibe.Services) naming a community.paste by its slug and its owner, and answers a
 * common.resource-control-result@1 (200 for every outcome, without `resource`: pastes have no OVRN; a malformed request
 * is a 400 problem).
 *
 *   delete    the paste goes through Community's own deletion path, exactly as its owner deleting it on
 *             openvibe.community (DELETE /api/pastes/:slug): soft-deleted, its content dropped, live viewers told
 *
 * Any other action is refused `control.unsupported_action`. Only the owner Community holds may be named: a paste of
 * another person (or one already gone) is refused as unknown, never confirmed to exist. dry_run decides and explains
 * without applying. The first answer per (caller, idempotency_key) is kept in community_control_log and returned for a
 * repeat; the same key with another request is refused `control.idempotency_conflict`.
 */
const crypto = require('crypto');
const express = require('express');
const contracts = require('openvibe-contracts');
const { hasCap } = require('../identity/viewer');
const store = require('../pastes/store');

const CAPABILITY = 'community.resource.control';
const KIND = 'community.paste';

function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
const digestOf = (request) => crypto.createHash('sha256')
    .update(canonical({ ...request, idempotency_key: undefined, confirmation_id: undefined, trace_id: undefined })).digest('hex');

function router({ db, viewers, pastes, now = () => Date.now() }) {
    const r = express.Router();
    const send = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const problemOf = (status, code, detail) => ({ type: `https://openvibe.network/problems/${code}`, title: code, status, code, detail });
    const result = (request, state, extra = {}) => ({ action: request.action, state, at: new Date(now()).toISOString(), ...extra });

    async function decide(request, caller) {
        if (request.owned.kind !== KIND) return result(request, 'refused', { problem: problemOf(404, 'resources.unknown_resource', `no paste ${request.owned.kind} ${request.owned.id}`) });
        if (request.action !== 'delete') return result(request, 'refused', { problem: problemOf(422, 'control.unsupported_action', `a paste takes delete, not ${request.action}`) });
        const p = await store.getBySlug(db, request.owned.id);
        if (!p || p.owner_subject !== request.owner.id) {
            return result(request, 'refused', { problem: problemOf(404, 'resources.unknown_resource', `no paste ${request.owned.id} of this person`) });
        }
        if (request.dry_run) return result(request, 'done', { result: { dry_run: true, would: 'delete the paste' } });
        // The owner's own deletion path, as the owner (the service acts for them; their subject is checked above).
        await pastes.remove({ kind: 'service', service: caller, subject: request.owner.id, claims: {}, staff: false }, p.slug);
        return result(request, 'done', { result: { deleted: true } });
    }

    r.use(viewers.middleware());
    r.use((req, res, next) => {
        const v = req.viewer || { kind: 'anonymous' };
        if (v.kind === 'service' && /^svc:/.test(String(v.service || '')) && hasCap(v, CAPABILITY)) return next();
        if (v.kind === 'anonymous') return send(req, res, 401, 'token.missing', `call with a service token holding ${CAPABILITY}`);
        return send(req, res, 403, 'capability.denied', `${CAPABILITY} is first-party and requires a service token that holds it`);
    });
    r.post('/', express.json({ limit: '16kb' }), async (req, res, next) => {
        try {
            const request = req.body;
            if (!request || typeof request !== 'object' || request.owned === undefined) {
                // Community holds no project resources: a project-scoped request names nothing here.
                return send(req, res, 400, 'control.bad_request', 'pastes are person-owned: send common.owned-resource-control-request@1');
            }
            const check = contracts.resources.checkControlRequest(request);
            if (!check.valid) return send(req, res, 400, 'control.bad_request', JSON.stringify(check.errors).slice(0, 500));
            const caller = req.viewer.service;
            const digest = digestOf(request);
            const seen = await db.prepare('SELECT digest, response FROM community_control_log WHERE caller = ? AND idempotency_key = ?').get(caller, request.idempotency_key);
            if (seen) {
                if (seen.digest !== digest) return send(req, res, 409, 'control.idempotency_conflict', 'this idempotency_key was used for another request');
                return res.json(typeof seen.response === 'string' ? JSON.parse(seen.response) : seen.response);
            }
            const answer = await decide(request, caller);
            await db.prepare(`INSERT INTO community_control_log (caller, idempotency_key, owner_subject, digest, response, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(caller, request.idempotency_key, request.owner.id, digest, JSON.stringify(answer), now());
            return res.json(answer);
        } catch (err) { return next(err); }
    });
    return r;
}

module.exports = { router, CAPABILITY, digestOf };
