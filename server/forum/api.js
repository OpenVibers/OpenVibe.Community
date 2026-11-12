'use strict';

/**
 * /api/v1/spaces and /api/v1/posts — the forum's JSON API (the pages in render/forum.js are the
 * no-JS equivalent; service.js holds the rules for both).
 *
 *   GET    /spaces                                        spaces the caller can open
 *   GET    /spaces/:space                                 one space
 *   GET    /spaces/:space/moderation-log                  its newest 100 moderation rows (public for public spaces)
 *   GET    /spaces/:space/threads?sort=hot|new|top&page=  threads (server pagination)
 *   POST   /spaces/:space/threads { title, body }         new thread (body is Markdown)
 *   GET    /spaces/:space/threads/:slug?page=             thread + posts
 *   DELETE /spaces/:space/threads/:slug { rule?, reason? } author or moderator
 *   POST   /spaces/:space/threads/:slug/posts { body }    reply
 *   POST   /spaces/:space/threads/:slug/votes { value }   1 | -1 | 0
 *   PUT    /spaces/:space/threads/:slug/state { pinned?, locked?, rule?, reason? }   moderators
 *   PUT    /spaces/:space/members-only { owner: 'usr_…' | null }        moderators (OpenVibe.VIP gate)
 *   PUT    /spaces/:space/threads/:slug/members-only { owner | true | null }   the author (own members) or moderators
 *   PUT    /spaces/:space/threads/:slug/labels { labels: [...] }          the author or moderators (content labels, L1)
 *   POST   /spaces/:space/threads { …, members_only: true | { owner } }        start a members-only thread
 *   POST   /spaces/:space/attachments (multipart `file`)  an image for a new thread or reply → { attachment: { media_id, url, … } };
 *                                                         then POST …/threads or …/posts with { attachments: [media_id] } (at most 4)
 *   GET    /spaces/:space/categories                      the space's categories (?category=<slug> filters threads)
 *   PUT    /spaces/:space/categories/:category { name, description?, position? }   moderators
 *   DELETE /spaces/:space/categories/:category            moderators (threads keep their place, uncategorised)
 *   PUT    /spaces/:space/threads/:slug/category { category: slug | null }   the author or moderators
 *   PUT    /spaces/:space/threads/:slug/status { status, rule?, reason? }  moderators: requests open|planned|in_progress|done|declined,
 *                                                         roadmap items planned|in_progress|done|paused (?status= filters)
 *   POST   /spaces { slug, name, description?, style?: feed|forum, votes?, reactions?, group?, parent?, visibility?, kind? }   moderators
 *   PUT    /spaces/:space/settings { name?, description?, style?, votes?, reactions?, group?, parent?, position?, kind? }  moderators
 *   POST   /spaces/:space/threads/:slug/crosspost { to: slug }  another space gets a thread linking back (people)
 *   PUT    /spaces/:space/chat-room { room: slug | https://openvibe.chat/r/<slug> }   the space's owner or staff, signed in
 *                                                         themselves (Chat checks they manage the room) → { chat_room, created }
 *   DELETE /spaces/:space/chat-room                       the space's owner or staff (idempotent) → { detached, chat }
 *   GET    /spaces/:space/moderators                      the space's own moderators → { space, moderators: [{ subject, username, display_name, added_by, added_at }] }
 *   PUT    /spaces/:space/moderators/:subject             add a person (usr_… or @username, resolved through the Network; 404 moderator.unknown_user)
 *                                                         — the space's moderators or staff (idempotent)
 *   DELETE /spaces/:space/moderators/:subject             remove one — the space's moderators or staff (idempotent)
 *   POST   /posts/:id/reactions { reaction: agree|winner|funny|informative|friendly|sympathy|dumb|disgusting|bad_reading|late|null }
 *   PUT    /posts/:id { body }   DELETE /posts/:id   GET /posts/:id/versions
 *
 * Services write with community.post.create (as X-OV-Subject, or as AI with X-OV-Origin: ai) and
 * moderate with community.comment.moderate. "moderators" on a /spaces/:space route means discussion staff or
 * one of that space's own moderators (people, signed in themselves). Errors are problem+json. A members-only space or thread
 * refuses readers and writers without the creator's VIP membership with 403 vip.members_only
 * ({ reason, gate, members_only: { owner, owner_username, join_url } }).
 */
const express = require('express');
const multer = require('multer');
const contracts = require('openvibe-contracts');
const { run, serviceCap, serviceAnyCap, jsonBody, fail } = require('../http/v1');

const POST = 'community.post.create';
const MOD = 'community.comment.moderate';

function createSpacesApi({ forum, viewers, limits }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    const write = serviceCap(POST);
    const writeOrMod = serviceAnyCap([POST, MOD]);
    const p = (req) => req.params;
    // A space's moderators: a service needs community.comment.moderate (as before); a browser must be discussion
    // staff or one of the space's own moderators (the service methods decide again, with 404 for a missing space).
    const spaceMod = (req, res, next) => {
        const v = req.viewer;
        if (v && v.kind === 'service') return serviceCap(MOD)(req, res, next);
        return forum.canModerate(v, p(req).space)
            .then((ok) => (ok ? next() : contracts.http.sendProblem(res, 403, 'capability.denied', { detail: "Only this forum's moderators", ctx: req.ov })))
            .catch(next);
    };
    // Per-actor limits (server/actor-limits.js): reads take the defaults. The person limits in service.js
    // (threads 3 a minute and a daily cap, replies 6, uploads 12, votes 60) keep deciding for people;
    // these cap requests, refused ones included, and every write that has no content limit.
    router.use(limits.reads('community.forum.read'));
    const configure = limits('community.space.configure', { minute: 30, hour: 300 });   // moderators' settings
    const editThread = limits('community.thread.edit', { minute: 30, hour: 300 });

    router.get('/', run(async (req) => await forum.listSpaces(req.viewer)));
    router.post('/', serviceCap(MOD), limits('community.space.create', { minute: 10, hour: 60 }), jsonBody, run(async (req) => await forum.createSpace(req.viewer, req.body || {}), 201));
    router.put('/:space/settings', configure, spaceMod, jsonBody, run(async (req) => await forum.updateSpaceSettings(req.viewer, p(req).space, req.body || {})));
    router.get('/:space', run(async (req) => await forum.space(req.viewer, p(req).space)));
    router.get('/:space/moderation-log', run(async (req) => await forum.moderationLog(req.viewer, p(req).space)));
    router.get('/:space/threads', run(async (req) => await forum.listThreads(req.viewer, p(req).space, req.query)));
    router.get('/:space/categories', run(async (req) => await forum.categories(req.viewer, p(req).space)));
    // An image to attach: multipart `file`; then name its media_id in `attachments` when posting.
    const one = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 5 } }).single('file');
    const withFile = (req, res, next) => one(req, res, (err) => (err
        ? contracts.http.sendProblem(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'attachments.too_large' : 'attachments.invalid', { detail: err.code === 'LIMIT_FILE_SIZE' ? 'Images are limited to 8 MB' : 'Send one image as multipart field `file`', ctx: req.ov })
        : next()));
    // An upload is stored in OpenVibe.Media: 20 a minute, above the 12 a person may keep.
    router.post('/:space/attachments', write, limits('community.attachment.upload', { minute: 20, hour: 200 }), withFile, run(async (req) => await forum.uploadAttachment(req.viewer, p(req).space, req.file), 201));
    router.put('/:space/categories/:category', configure, spaceMod, jsonBody, run(async (req) => await forum.putCategory(req.viewer, p(req).space, p(req).category, req.body || {})));
    router.delete('/:space/categories/:category', configure, spaceMod, run(async (req) => await forum.deleteCategory(req.viewer, p(req).space, p(req).category)));
    router.put('/:space/threads/:slug/category', writeOrMod, editThread, jsonBody, run(async (req) => await forum.setThreadCategory(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/status', configure, spaceMod, jsonBody, run(async (req) => await forum.setThreadStatus(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.post('/:space/threads/:slug/crosspost', write, limits('community.thread.crosspost', { minute: 10, hour: 60 }), jsonBody, run(async (req) => await forum.crosspost(req.viewer, p(req).space, p(req).slug, req.body || {}), 201));
    router.post('/:space/threads', write, limits('community.thread.create', { minute: 10, hour: 60 }), jsonBody, run(async (req) => await forum.createThread(req.viewer, p(req).space, req.body || {}), 201));
    router.get('/:space/threads/:slug', run(async (req) => await forum.getThread(req.viewer, p(req).space, p(req).slug, req.query)));
    router.delete('/:space/threads/:slug', writeOrMod, editThread, jsonBody, run(async (req) => await forum.deleteThread(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.post('/:space/threads/:slug/posts', write, limits('community.post.create', { minute: 20, hour: 300 }), jsonBody, run(async (req) => await forum.reply(req.viewer, p(req).space, p(req).slug, req.body || {}), 201));
    router.post('/:space/threads/:slug/votes', write, limits('community.thread.vote', { minute: 120, hour: 1200 }), jsonBody, run(async (req) => await forum.voteThread(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/state', configure, spaceMod, jsonBody, run(async (req) => await forum.moderateThread(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/members-only', writeOrMod, editThread, jsonBody, run(async (req) => await forum.setThreadMembersOnly(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/threads/:slug/labels', writeOrMod, editThread, jsonBody, run(async (req) => await forum.setThreadLabels(req.viewer, p(req).space, p(req).slug, req.body || {})));
    router.put('/:space/members-only', configure, spaceMod, jsonBody, run(async (req) => await forum.setSpaceMembersOnly(req.viewer, p(req).space, req.body || {})));
    // A chat room (OpenVibe.Chat): people attach with their own token; moderator services may only detach.
    router.put('/:space/chat-room', configure, jsonBody, run(async (req) => await forum.attachChatRoom(req.viewer, p(req).space, req.body || {}), (out) => (out.created ? 201 : 200)));
    router.delete('/:space/chat-room', serviceCap(MOD), configure, run(async (req) => await forum.detachChatRoom(req.viewer, p(req).space)));
    // The space's own moderators (people): listed to its readers, added and removed by its moderators or staff.
    router.get('/:space/moderators', run(async (req) => await forum.moderators(req.viewer, p(req).space)));
    router.put('/:space/moderators/:subject', configure, spaceMod, run(async (req) => await forum.addModerator(req.viewer, p(req).space, p(req).subject)));
    router.delete('/:space/moderators/:subject', configure, spaceMod, run(async (req) => await forum.removeModerator(req.viewer, p(req).space, p(req).subject)));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

function createPostsApi({ forum, pulse = null, viewers, limits, baseUrl = '', mediaUrl = 'https://openvibe.media' }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    const writeOrMod = serviceAnyCap([POST, MOD]);
    // Per-actor limits (server/actor-limits.js), as on /api/v1/spaces.
    router.use(limits.reads('community.forum.read'));

    // POST /api/v1/posts — a status post (a thread in the Status space) with up to four pictures, which is in the
    // Feed at once. Pictures are Media objects the person owns ({ media_id, alt }); the forum service checks that
    // and remembers the alt text. Same rules as POST /api/v1/me/status: people only, text required.
    router.post('/', limits('community.post.create', { minute: 6, hour: 30 }), jsonBody, run(async (req) => {
        const v = req.viewer;
        if (!v || v.kind !== 'user' || !v.subject) fail(401, 'post.sign_in_required', 'Sign in to post');
        const body = req.body || {};
        if (Object.keys(body).some((k) => !['text', 'pictures', 'attachments'].includes(k))) fail(400, 'post.invalid', 'Only text, pictures and attachments are accepted');
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const hasFiles = (Array.isArray(body.pictures) && body.pictures.length > 0) || (Array.isArray(body.attachments) && body.attachments.length > 0);
        // A picture alone is a post, as on any social app (the owner, 11-12); with nothing at all it is not.
        if (!text && !hasFiles) fail(400, 'post.invalid', 'Write something or add a picture');
        if (text.length > 2000) fail(400, 'post.invalid', 'Text is at most 2000 characters');
        const pictures = body.pictures == null ? [] : body.pictures;
        if (!Array.isArray(pictures) || pictures.length > 4) fail(400, 'post.invalid_pictures', 'pictures is an array of at most four { media_id, alt }');
        for (const p of pictures) {
            if (!p || typeof p.media_id !== 'string' || (p.alt != null && typeof p.alt !== 'string')) fail(400, 'post.invalid_pictures', 'Every picture is { media_id, alt? }');
        }
        const fileIds = body.attachments == null ? [] : body.attachments;
        if (!Array.isArray(fileIds) || fileIds.length > 10 || fileIds.some((id) => !/^att_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) || new Set(fileIds).size !== fileIds.length) {
            fail(400, 'post.invalid_attachments', 'attachments is an array of up to ten Media composer attachment ids');
        }
        const files = [];
        const mediaOrigin = new URL(mediaUrl).origin;
        for (const id of fileIds) {
            let kept;
            try {
                kept = await fetch(`${mediaOrigin}/api/v1/attachments/${id}/keep`, {
                    method: 'POST', headers: { Authorization: String(req.get('authorization') || ''), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message_id: `community:post:${id}` }), signal: AbortSignal.timeout(10000),
                });
            } catch { fail(502, 'post.attachment_unavailable', 'Media did not answer'); }
            if (!kept.ok) fail(kept.status === 404 ? 400 : 502, 'post.attachment_unavailable', 'A file could not be attached');
            const f = await kept.json();
            let url;
            try { url = new URL(String(f.url || ''), mediaOrigin); } catch { fail(502, 'post.attachment_invalid', 'Media returned an invalid attachment'); }
            if (f.kind === 'image' || /^image\//.test(String(f.mime || ''))) fail(400, 'post.picture_alt_required', 'Pictures need alt text in pictures');
            if (f.id !== id || url.origin !== mediaOrigin || !url.pathname.startsWith(`/a/${id}/`) || !Number.isFinite(Number(f.size)) || Number(f.size) < 0) {
                fail(502, 'post.attachment_invalid', 'Media returned an invalid attachment');
            }
            files.push({ id, name: String(f.name || 'File').slice(0, 255), mime: String(f.mime || 'application/octet-stream').slice(0, 120), size: Number(f.size), url: url.href });
        }
        // A picture-only post is named by what it shows (its alt text), so two of them are not "the same thread".
        const firstAlt = String((pictures[0] && pictures[0].alt) || '').trim();
        const title = `Status: ${text.replace(/https?:\/\/[^\s<>]+/gi, '').trim().slice(0, 110) || firstAlt.slice(0, 110) || `Shared a picture · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`}`;
        const { thread, post } = await forum.createThread(v, 'status', { title, body: text, pictures: pictures.map((p) => ({ media_id: p.media_id, alt: String(p.alt || '') })) });
        if (files.length) await forum.attachComposerFiles(v, post.id, files);
        if (pulse) {
            await pulse.forgetLocal('thread', thread.id);
            const first = (post.attachments || [])[0];
            await pulse.statusCreated(thread, text, v.subject, first && first.url);
        }
        return { id: thread.id, post_id: post.id, text,
            url: `${String(baseUrl).replace(/\/$/, '')}/forum/status/${thread.slug}`,
            pictures: (post.attachments || []).filter((a) => /^image\//.test(a.mime)).map((a) => ({ media_id: a.media_id, alt: a.alt || null, url: a.url })),
            attachments: files,
            created_at: thread.created_at };
    }, 201));

    router.put('/:id', writeOrMod, limits('community.post.edit', { minute: 30, hour: 300 }), jsonBody, run(async (req) => await forum.editPost(req.viewer, req.params.id, req.body || {})));
    router.post('/:id/reactions', serviceCap(POST), limits('community.post.react', { minute: 120, hour: 1200 }), jsonBody, run(async (req) => await forum.react(req.viewer, req.params.id, req.body || {})));
    router.delete('/:id', writeOrMod, limits('community.post.delete', { minute: 60, hour: 600 }), jsonBody, run(async (req) => await forum.deletePost(req.viewer, req.params.id, req.body || {})));
    router.get('/:id/versions', writeOrMod, run(async (req) => await forum.postVersions(req.viewer, req.params.id)));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

/** /api/v1/space-groups — the board index's groups: GET (everyone), PUT /:group { name, description?, position? } (moderators). */
function createGroupsApi({ forum, viewers, limits }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());
    // Per-actor limits (server/actor-limits.js), as on /api/v1/spaces.
    router.use(limits.reads('community.forum.read'));
    router.get('/', run(async (req) => ({ groups: (await forum.listSpaces(req.viewer)).groups.map(({ spaces, ...g }) => ({ ...g, spaces: spaces.map((sp) => sp.slug) })) })));
    router.put('/:group', serviceCap(MOD), limits('community.space.configure', { minute: 30, hour: 300 }), jsonBody, run(async (req) => await forum.putGroup(req.viewer, req.params.group, req.body || {})));
    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createSpacesApi, createPostsApi, createGroupsApi };
