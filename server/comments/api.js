'use strict';

/**
 * /api/v1/comments — typed comment threads other products embed (service.js has the rules).
 *
 *   POST   /threads/resolve             { ref: EntityRef } → get-or-create (201 created, 200 existing)
 *   GET    /threads/:id                 thread + first page (?after=<id>&sort=old|new&limit=, ?parent=<id>)
 *                                        :id is the access id (cth_…); the sequential id is for services only
 *   POST   /threads/:id/comments        { message, parent_id?, anon_name? }
 *   PUT    /threads/:id/visibility      { visibility: public|hidden|locked }   moderators
 *   GET    /:commentId                  one comment + its thread (ref included)   services only
 *   PATCH  /:commentId                  { message }   the author only
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

function createCommentsApi({ service, viewers, anonWriteLimiter, resolveLimiter, limits }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    // Per-actor limits (server/actor-limits.js): reads take the defaults. The person limits in service.js
    // (a comment every 10 s, 5 a minute; 60 votes a minute) keep deciding for people; these cap requests,
    // refused ones included, and every write that has no content limit.
    router.use(limits.reads('community.comment.read'));
    const moderate = limits('community.comment.moderate', { minute: 60, hour: 600 });

    const read = serviceAnyCap([WRITE, MOD]);
    const passAnon = (_req, _res, next) => next();

    // Opening a thread writes a row the first time: a person opens at most one a second.
    router.post('/threads/resolve', serviceCap(WRITE), limits('community.thread.resolve', { minute: 60, hour: 1200 }), resolveLimiter || passAnon, jsonBody,
        run(async (req) => await service.resolve(req.viewer, req.body || {}), (out) => (out.created ? 201 : 200)));
    router.get('/threads/:id', read, run(async (req) => await service.get(req.viewer, req.params.id, req.query)));
    router.post('/threads/:id/comments', serviceCap(WRITE), limits('community.comment.create', { minute: 20, hour: 300 }), anonWriteLimiter || passAnon, jsonBody,
        run(async (req) => await service.add(req.viewer, req.params.id, req.body || {}), 201));
    router.put('/threads/:id/visibility', serviceCap(MOD), moderate, jsonBody, run(async (req) => await service.setVisibility(req.viewer, req.params.id, req.body || {})));
    router.get('/:commentId', read, run(async (req) => await service.getComment(req.viewer, req.params.commentId)));
    router.patch('/:commentId', serviceCap(WRITE), limits('community.comment.edit', { minute: 30, hour: 300 }), jsonBody, run(async (req) => await service.edit(req.viewer, req.params.commentId, req.body || {})));
    router.delete('/:commentId', serviceAnyCap([WRITE, MOD]), moderate, run(async (req) => await service.remove(req.viewer, req.params.commentId)));
    router.post('/:commentId/votes', serviceCap(WRITE), limits('community.comment.vote', { minute: 120, hour: 1200 }), jsonBody, run(async (req) => await service.vote(req.viewer, req.params.commentId, req.body || {})));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createCommentsApi };
