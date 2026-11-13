'use strict';

const multer = require('multer');
const { ApiError } = require('../http/v1');

const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 4, fileSize: 16 * 1024 * 1024, fields: 5 } }).array('files', 4);

function parse(req, res, next) {
    if (!req.is('multipart/form-data')) return next();
    return upload(req, res, (err) => next(err ? new ApiError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
        'comment.attachment_invalid', err.code === 'LIMIT_FILE_SIZE' ? 'A file can be up to 16 MB' : 'Attach up to four files') : null));
}

/**
 * The files the person uploaded through Media's composer and named in the form: a JSON field with
 * [{ media_attachment_id }]. A form may also carry the old file upload (the files field), which is untouched.
 */
function namedAttachments(raw) {
    if (raw == null || raw === '') return [];
    let value = raw;
    if (typeof value === 'string' && /^att_[0-9A-HJKMNP-TV-Z]{26}$/.test(value.trim())) value = [value];
    else if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch { throw new ApiError(400, 'comment.attachment_invalid', 'That attachment list is not valid'); }
    }
    if (!Array.isArray(value)) value = [value];
    // Shared's composer (4.247.0) sends one `attachments=att_…` per file it uploaded to Media: a plain id is the same
    // as { media_attachment_id }, and each item of a repeated field may be either (or a JSON list of them).
    const out = [];
    for (let item of value) {
        if (typeof item === 'string') {
            const t = item.trim();
            if (/^att_[0-9A-HJKMNP-TV-Z]{26}$/.test(t)) { out.push({ media_attachment_id: t }); continue; }
            try { item = JSON.parse(t); } catch { throw new ApiError(400, 'comment.attachment_invalid', 'That attachment list is not valid'); }
            for (const x of (Array.isArray(item) ? item : [item])) if (x && typeof x === 'object' && x.media_attachment_id) out.push(x);
            continue;
        }
        if (item && typeof item === 'object' && item.media_attachment_id) out.push(item);
    }
    return out;
}

async function bodyFor(comments, viewer, ref, req) {
    const body = req.body || {};
    const message = String(body.message || '').trim();
    const files = req.files || [];
    const named = namedAttachments(body.attachments);
    // A picture alone is a comment, as on any social app (the owner, 11-12): words are optional when a file is attached.
    if ((!message && !files.length && !named.length) || message.length > 2000) throw new ApiError(400, 'comment.message_invalid', 'Write something or attach a picture (up to 2,000 characters)');
    const parent = String(body.parent_id || '');
    if (parent && !/^\d{1,15}$/.test(parent)) throw new ApiError(400, 'comment.parent_invalid', 'That reply target is not valid');
    const attachments = [...named];
    for (const file of files) {
        if (!TYPES.has(file.mimetype)) throw new ApiError(415, 'comment.file_type', 'Attach JPEG, PNG, GIF, WebP, PDF or text files');
        const out = await comments.uploadAttachment(viewer, ref, file);
        attachments.push(out.attachment);
    }
    return { message, parent_id: parent || null, attachments };
}

module.exports = { parse, bodyFor, namedAttachments };
