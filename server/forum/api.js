'use strict';

/**
 * /api/v1/spaces and /api/v1/posts — the forum's JSON API (the pages in render/forum.js are the
 * no-JS equivalent; service.js holds the rules for both).
 *
 *   GET    /spaces                                        spaces the caller can open
 *   GET    /spaces/:space                                 one space
 *   GET    /spaces/:space/threads?sort=hot|new|top&page=  threads (server pagination)
 *   POST   /spaces/:space/threads { title, body }         new thread (body is Markdown)
 *   GET    /spaces/:space/threads/:slug?page=             thread + posts
 *   DELETE /spaces/:space/threads/:slug                   author or moderator
 *   POST   /spaces/:space/threads/:slug/posts { body }    reply
 *   POST   /spaces/:space/threads/:slug/votes { value }   1 | -1 | 0
 *   PUT    /spaces/:space/threads/:slug/state { pinned?, locked? }   moderators
 *   PUT    /spaces/:space/members-only { owner: 'usr_…' | null }        moderators (OpenVibe.VIP gate)
 *   PUT    /spaces/:space/threads/:slug/members-only { owner | true | null }   the author (own members) or moderators
 *   POST   /spaces/:space/threads { …, members_only: true | { owner } }        start a members-only thread
 *   POST   /spaces/:space/attachments (multipart `file`)  an image for a new thread or reply → { attachment: { media_id, url, … } };
 *                                                         then POST …/threads or …/posts with { attachments: [media_id] } (at most 4)
 *   GET    /spaces/:space/categories                      the space's categories (?category=<slug> filters threads)
 *   PUT    /spaces/:space/categories/:category { name, description?, position? }   moderators
 *   DELETE /spaces/:space/categories/:category            moderators (threads keep their place, uncategorised)
 *   PUT    /spaces/:space/threads/:slug/category { category: slug | null }   the author or moderators
 *   PUT    /spaces/:space/threads/:slug/status { status }  moderators: requests open|planned|in_progress|done|declined,
 *                                                         roadmap items planned|in_progress|done|paused (?status= filters)
 *   POST   /spaces { slug, name, description?, style?: feed|forum, votes?, reactions?, group?, parent?, visibility?, kind? }   moderators
 *   PUT    /spaces/:space/settings { name?, description?, style?, votes?, reactions?, group?, parent?, position?, kind? }  moderators
 *   POST   /spaces/:space/threads/:slug/crosspost { to: slug }  another space gets a thread linking back (people)
 *   POST   /posts/:id/reactions { reaction: agree|winner|funny|informative|friendly|sympathy|dumb|disgusting|bad_reading|late|null }
 *   PUT    /posts/:id { body }   DELETE /posts/:id   GET /posts/:id/versions
 *
 * Services write with community.post.create (as X-OV-Subject, or as AI with X-OV-Origin: ai) and
 * moderate with community.comment.moderate. Errors are problem+json. A members-only space or thread
 * refuses readers and writers without the creator's VIP membership with 403 vip.members_only
 * ({ reason, gate, members_only: { owner, owner_username, join_url } }).
 */
const express = require('express');
const multer = require('multer');
const contracts = require('openvibe-contracts');
const { run, serviceCap, serviceAnyCap, jsonBody } = require('../http/v1');

const POST = 'community.post.create';
const MOD = 'community.comment.moderate';

function createSpacesApi({ forum, viewers }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    const write = serviceCap(POST);
    const writeOrMod = serviceAnyCap([POST, MOD]);
    const p = (req) => req.params;

    router.get('/', run((req) => forum.listSpaces(req.viewer)));
    router.post('/', serviceCap(MOD), jsonBody, run((req) => forum.createSpace(req.viewer, req.body || {}), 201));
    router.put('/:space/settings', serviceCap(MOD), jsonBody, run((req) => forum.updateSpaceSettings(req.viewer, p(req).space, req.body || {})));
    router.get('/:space', run((req) => forum.space(req.viewer, p(req).space)));
    router.get('/:space/threads', run((req) => forum.listThreads(req.viewer, p(req).space, req.query)));
    router.get('/:space/categories', run((req) => forum.categories(req.viewer, p(req).space)));
    // An image to attach: multipart `file`; then name its media_id in `attachments` when posting.
    const one = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
    const withFile = (req, res, next) => one(req, res, (err) => (err
        ? contracts.http.sendProblem(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'attachments.too_large' : 'attachments.invalid', { detail: err.code === 'LIMIT_FILE_SIZE' ? 'Images are limited to 8 MB' : 'Send one image as multipart field `file`', ctx: req.ov })
        : next()));
    router.post('/:space/attachments', write, withFile, run((req) => forum.uploadAttachment(req.viewer, p(req).space, req.file), 201));
    router.put('/:space/categories/:category', serviceCap(MOD), jsonBody, run((req) => forum.putCategory(req.viewer, p(req).space, p(req).category, req.body || {})));
    router.delete('/:space/categories/:category', serviceCap(MOD), run((req) => forum.deleteCategory(req.viewer, p(req).space, p(req).category)));
    router.put('/:space/threads/:slug/category', writeOrMod, jsonBody, run((req) => forum.setThreadCategory(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/status', serviceCap(MOD), jsonBody, run((req) => forum.setThreadStatus(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.post('/:space/threads/:slug/crosspost', write, jsonBody, run((req) => forum.crosspost(req.viewer, p(req).space, p(req).slug, req.body || {}), 201));
    router.post('/:space/threads', write, jsonBody, run((req) => forum.createThread(req.viewer, p(req).space, req.body || {}), 201));
    router.get('/:space/threads/:slug', run((req) => forum.getThread(req.viewer, p(req).space, p(req).slug, req.query)));
    router.delete('/:space/threads/:slug', writeOrMod, run((req) => forum.deleteThread(req.viewer, p(req).space, p(req).slug)));
    router.post('/:space/threads/:slug/posts', write, jsonBody, run((req) => forum.reply(req.viewer, p(req).space, p(req).slug, req.body || {}), 201));
    router.post('/:space/threads/:slug/votes', write, jsonBody, run((req) => forum.voteThread(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/state', serviceCap(MOD), jsonBody, run((req) => forum.moderateThread(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/members-only', writeOrMod, jsonBody, run((req) => forum.setThreadMembersOnly(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/members-only', serviceCap(MOD), jsonBody, run((req) => forum.setSpaceMembersOnly(req.viewer, p(req).space, req.body || {})));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

function createPostsApi({ forum, viewers }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    const writeOrMod = serviceAnyCap([POST, MOD]);

    router.put('/:id', writeOrMod, jsonBody, run((req) => forum.editPost(req.viewer, req.params.id, req.body || {})));
    router.post('/:id/reactions', serviceCap(POST), jsonBody, run((req) => forum.react(req.viewer, req.params.id, req.body || {})));
    router.delete('/:id', writeOrMod, run((req) => forum.deletePost(req.viewer, req.params.id)));
    router.get('/:id/versions', writeOrMod, run((req) => forum.postVersions(req.viewer, req.params.id)));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

/** /api/v1/space-groups — the board index's groups: GET (everyone), PUT /:group { name, description?, position? } (moderators). */
function createGroupsApi({ forum, viewers }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    router.get('/', run(async (req) => ({ groups: (await forum.listSpaces(req.viewer)).groups.map(({ spaces, ...g }) => ({ ...g, spaces: spaces.map((sp) => sp.slug) })) })));
    router.put('/:group', serviceCap(MOD), jsonBody, run((req) => forum.putGroup(req.viewer, req.params.group, req.body || {})));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createSpacesApi, createPostsApi, createGroupsApi };
