'use strict';

/** The attachment reference shape shared with Chat (ai.file@1). Bytes live in Media. */
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_MAX = 255;

function cleanReference(raw, subject) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const id = String(value.id || '');
    if (!MEDIA_ID.test(id) || !value.storage || value.storage.provider !== 'media' || String(value.storage.key) !== id) {
        const err = new Error('Each attachment must be a stored Media object reference');
        err.status = 400; err.code = 'comment.attachment_invalid'; throw err;
    }
    const mediaType = String(value.media_type || 'application/octet-stream').split(';')[0].trim().slice(0, NAME_MAX) || 'application/octet-stream';
    const name = String(value.name || 'file').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NAME_MAX) || 'file';
    return {
        id, name, media_type: mediaType, size: Math.max(0, Math.floor(Number(value.size) || 0)),
        storage: { provider: 'media', key: id },
        access: { readers: [subject] },
        read: { method: 'not_readable', reason: 'Attached; open the comment to read it.' },
        role: 'input',
    };
}

function publicReference(row) {
    return {
        id: row.media_id, name: row.filename || 'file', media_type: row.mime || 'application/octet-stream',
        size: Number(row.size_bytes) || 0, storage: { provider: 'media', key: row.media_id },
        access: { readers: [row.owner_subject] }, read: { method: 'not_readable', reason: 'Attached to a comment.' },
        role: 'input',
    };
}

module.exports = { MEDIA_ID, cleanReference, publicReference };
