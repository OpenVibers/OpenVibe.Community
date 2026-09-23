'use strict';

/**
 * /api/v1/relay — Discord relay administration, staff only (an admin/global_mod browser, or a
 * service holding community.comment.moderate: acting as itself, or vouching with X-OV-Staff).
 *
 *   GET  /deliveries?status=pending|delivered|failed&limit=   what was sent, what is failing and why
 *   POST /deliveries/:id/retry                                 queue a failed delivery again
 *   GET  /mappings                                             space → webhook variable name
 *   POST /mappings { space, webhook_url_ref, enabled? }        map a space (the URL stays in the env)
 *   PUT  /mappings/:id { enabled }
 *
 * Responses never contain a webhook URL, only the variable name and whether it is set.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, fail, intIn } = require('../http/v1');
const { discussionModerator } = require('../identity/capabilities');
const forumStore = require('../forum/store');

function createRelayApi({ relay, db, viewers }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());

    router.use((req, res, next) => {
        const v = req.viewer;
        if (discussionModerator(v)) return next();
        if (v.kind === 'anonymous') return contracts.http.sendProblem(res, 401, 'auth.required', { detail: 'Sign in as staff', ctx: req.ov });
        return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: 'Relay administration is for staff', ctx: req.ov });
    });

    const idOf = (req) => (/^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : fail(404, 'route.not_found', 'Not found'));

    router.get('/deliveries', run((req) => {
        const status = ['pending', 'delivered', 'failed'].includes(req.query.status) ? req.query.status : null;
        return { enabled: relay.enabled, deliveries: relay.listDeliveries({ status, limit: intIn(req.query.limit, 50, 1, 200) }) };
    }));
    router.post('/deliveries/:id/retry', run((req) => {
        if (!relay.retry(idOf(req))) fail(404, 'relay.delivery_not_found', 'No such delivery waiting to be sent');
        return { ok: true };
    }));
    router.get('/mappings', run(() => ({ enabled: relay.enabled, mappings: relay.listMappings() })));
    router.post('/mappings', jsonBody, run((req) => {
        const b = req.body || {};
        const space = forumStore.getSpace(db, String(b.space || ''));
        if (!space) fail(400, 'relay.invalid_space', 'Unknown space');
        const ref = String(b.webhook_url_ref || '');
        if (!relay.ENV_NAME.test(ref)) fail(400, 'relay.invalid_ref', 'webhook_url_ref is the NAME of an environment variable (A-Z, 0-9, _), never the URL');
        return { mapping: relay.addMapping({ space_id: space.id, webhook_url_ref: ref, enabled: b.enabled !== false }) };
    }, 201));
    router.put('/mappings/:id', jsonBody, run((req) => {
        const m = relay.setMappingEnabled(idOf(req), !!(req.body || {}).enabled);
        if (!m) fail(404, 'relay.mapping_not_found', 'No such mapping');
        return { mapping: m };
    }));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createRelayApi };
