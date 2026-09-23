'use strict';

/**
 * /api/v1/comments — typed comment threads other products embed (service.js has the rules).
 *
 *   POST   /threads/resolve             { ref: EntityRef } → get-or-create (201 created, 200 existing)
 *   GET    /threads/:id                 thread + first page (?after=<id>&sort=old|new&limit=, ?parent=<id>)
 *   POST   /threads/:id/comments        { message, parent_id?, anon_name? }
 *   PUT    /threads/:id/visibility      { visibility: public|hidden|locked }   moderators
 *   DELETE /:commentId                  author or moderator
 *   POST   /:commentId/votes            { value: 1|-1|0 }
 *
 * Callers: browsers (the Network user JWT as ov_token cookie or Bearer — other OpenVibe sites use
 * Bearer through CORS), anonymous browsers (comments with an anon_name, under the shared
 * anonymous-write budget), and services with a Network service token: community.comment.write
 * to resolve/comment/vote/delete as X-OV-Subject (or as AI with X-OV-Origin: ai),
 * community.comment.moderate for visibility and moderation. Errors are problem+json.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, serviceCap, serviceAnyCap, jsonBody } = require('../http/v1');

const WRITE = 'community.comment.write';
const MOD = 'community.comment.moderate';

function createCommentsApi({ service, viewers, anonWriteLimiter, resolveLimiter }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());

    const read = serviceAnyCap([WRITE, MOD]);
    const passAnon = (_req, _res, next) => next();

    router.post('/threads/resolve', serviceCap(WRITE), resolveLimiter || passAnon, jsonBody,
        run((req) => service.resolve(req.viewer, req.body || {}), (out) => (out.created ? 201 : 200)));
    router.get('/threads/:id', read, run((req) => service.get(req.viewer, req.params.id, req.query)));
    router.post('/threads/:id/comments', serviceCap(WRITE), anonWriteLimiter || passAnon, jsonBody,
        run((req) => service.add(req.viewer, req.params.id, req.body || {}), 201));
    router.put('/threads/:id/visibility', serviceCap(MOD), jsonBody, run((req) => service.setVisibility(req.viewer, req.params.id, req.body || {})));
    router.delete('/:commentId', serviceAnyCap([WRITE, MOD]), run((req) => service.remove(req.viewer, req.params.commentId)));
    router.post('/:commentId/votes', serviceCap(WRITE), jsonBody, run((req) => service.vote(req.viewer, req.params.commentId, req.body || {})));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createCommentsApi };
