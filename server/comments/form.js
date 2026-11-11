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

async function bodyFor(comments, viewer, ref, req) {
    const body = req.body || {};
    const message = String(body.message || '').trim();
    if (!message || message.length > 2000) throw new ApiError(422, 'comment.message_invalid', 'A comment is 1 to 2,000 characters');
    const parent = String(body.parent_id || '');
    if (parent && !/^\d{1,15}$/.test(parent)) throw new ApiError(400, 'comment.parent_invalid', 'That reply target is not valid');
    const files = req.files || [];
    const attachments = [];
    for (const file of files) {
        if (!TYPES.has(file.mimetype)) throw new ApiError(415, 'comment.file_type', 'Attach JPEG, PNG, GIF, WebP, PDF or text files');
        const out = await comments.uploadAttachment(viewer, ref, file);
        attachments.push(out.attachment);
    }
    return { message, parent_id: parent || null, attachments };
}

module.exports = { parse, bodyFor };
