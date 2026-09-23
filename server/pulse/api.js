'use strict';

/**
 * /api/v1/pulse — the network's public activity (service.js has the rules).
 *
 *   GET    /                               ?origin=user|ai|system&after=<cursor>&limit=   anyone
 *   POST   /items                          { ref, title, url, origin?, occurred_at?, visibility? }
 *   DELETE /items/:service/:type/:id       retract one of the calling service's items
 *
 * Writes need a service token with community.pulse.write; X-OV-Subject names the person an item
 * is about (origin user), X-OV-Origin: ai marks AI output. Errors are problem+json.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, serviceCap, jsonBody } = require('../http/v1');

const WRITE = 'community.pulse.write';

function createPulseApi({ pulse, viewers }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());

    const servicesOnly = (req, res, next) => (req.viewer.kind === 'service' ? next()
        : contracts.http.sendProblem(res, 403, 'capability.denied', { detail: `a service token with ${WRITE} is required`, ctx: req.ov }));

    router.get('/', run((req) => pulse.list(req.query)));
    router.post('/items', servicesOnly, serviceCap(WRITE), jsonBody, run((req) => pulse.ingest(req.viewer, req.body || {}), (out) => (out.created ? 201 : 200)));
    router.delete('/items/:service/:type/:id', servicesOnly, serviceCap(WRITE), run((req) => pulse.retract(req.viewer, req.params.service, req.params.type, req.params.id)));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createPulseApi };
