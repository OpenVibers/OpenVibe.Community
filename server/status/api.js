'use strict';
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, fail, jsonBody } = require('../http/v1');

const HTTPS_LINK = /https:\/\/[^\s<>]+/gi;

function createStatusApi({ forum, pulse, viewers, limits, db, baseUrl }) {
    const r = express.Router();
    r.use(contracts.http.middleware());
    r.use(viewers.middleware());
    r.use(limits.reads('community.pulse.read'));
    r.post('/', limits('community.status.write', { minute: 6, hour: 30 }), jsonBody, run(async (req) => {
        if (req.viewer.kind !== 'user' || !req.viewer.subject) fail(401, 'status.sign_in_required', 'Sign in to post a status');
        const body = req.body || {};
        if (Object.keys(body).some((key) => !['text', 'link'].includes(key))) fail(400, 'status.invalid', 'Only text and link are accepted');
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        const links = text.match(/https?:\/\/[^\s<>]+/gi) || [];
        if (body.link != null) links.push(body.link);
        if (body.link != null) {
            let parsed;
            try { parsed = new URL(body.link); } catch { fail(400, 'status.invalid_link', 'A valid https link is required'); }
            if (parsed.protocol !== 'https:' || !parsed.hostname) fail(400, 'status.invalid_link', 'A valid https link is required');
        }
        if (links.length > 1 || links.some((link) => !link.startsWith('https://'))
            || !contracts.validate('community.status@1', { text, ...(body.link == null ? {} : { link: body.link }) }).valid) {
            fail(400, 'status.invalid', 'Text must be 1–500 characters and contain at most one https link');
        }
        const title = `Status: ${text.replace(/https:\/\/[^\s<>]+/gi, '').trim().slice(0, 110) || 'Shared a link'}`;
        const { thread, post } = await forum.createThread(req.viewer, 'status', { title, body: text });
        await pulse.forgetLocal('thread', thread.id);
        await pulse.statusCreated(thread, text, req.viewer.subject);
        return { text, link: links[0] || null, id: thread.id, post_id: post.id,
            url: `${baseUrl.replace(/\/$/, '')}/forum/status/${thread.slug}`, created_at: thread.created_at };
    }, 201));
    return r;
}

function createProfileStatusApi({ db, baseUrl, viewers, limits }) {
    const r = express.Router();
    r.use(contracts.http.middleware());
    r.use(viewers.middleware());
    r.use(limits.reads('community.pulse.read'));
    r.get('/:subject/statuses', run(async (req) => {
        const rows = await db.prepare(`SELECT t.id, t.slug, t.created_at, p.id AS post_id, p.body_markdown AS text
            FROM threads t JOIN spaces s ON s.id = t.space_id JOIN posts p ON p.thread_id = t.id AND p.is_opening = 1
            WHERE s.slug = 'status' AND t.author_subject = ? AND t.deleted_at IS NULL AND p.deleted_at IS NULL
            ORDER BY t.created_at DESC, t.id DESC LIMIT 20`).all(req.params.subject);
        return { statuses: rows.map((x) => ({ ...x, link: (x.text.match(HTTPS_LINK) || [])[0] || null,
            url: `${baseUrl.replace(/\/$/, '')}/forum/status/${x.slug}` })) };
    }));
    return r;
}

module.exports = { createStatusApi, createProfileStatusApi };
