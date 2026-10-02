'use strict';

/**
 * /api/v1/submissions — clips, art, ideas and reports for community review (service.js has the rules).
 *
 *   GET  /                    ?kind=&status=&mine=1&after=<cursor>&limit=   anyone (accepted); mine=1 own; moderators any
 *   POST /                    { kind, title, body?, url?, media_ref? }      a signed-in person (browser JWT)
 *   GET  /:slug                                                             accepted: anyone; else author/moderators
 *   POST /:slug/withdraw                                                    the author
 *   POST /:slug/review        { decision: accept|reject, note? }            discussion moderators
 *
 * Identity is the JWT (ov_token cookie or Bearer) or a service token, never the body. Errors are
 * problem+json.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody } = require('../http/v1');

function createSubmissionsApi({ submissions, viewers, limits }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    // Per-actor limits (server/actor-limits.js): reads take the defaults; the service's daily cap decides
    // how many a person sends, this caps the requests.
    router.use(limits.reads('community.submission.read'));
    const write = limits('community.submission.write', { minute: 20, hour: 120 });
    const review = limits('community.submission.review', { minute: 60, hour: 600 });

    router.get('/', run(async (req) => await submissions.list(req.viewer, req.query)));
    router.post('/', write, jsonBody, run(async (req) => await submissions.create(req.viewer, req.body || {}), 201));
    router.get('/:slug', run(async (req) => await submissions.get(req.viewer, req.params.slug)));
    router.post('/:slug/withdraw', write, run(async (req) => await submissions.withdraw(req.viewer, req.params.slug)));
    router.post('/:slug/review', review, jsonBody, run(async (req) => await submissions.review(req.viewer, req.params.slug, req.body || {})));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createSubmissionsApi };
