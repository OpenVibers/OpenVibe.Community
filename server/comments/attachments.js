'use strict';

/**
 * The attachment reference shape shared with Chat (ai.file@1). Bytes live in Media.
 *
 * Two kinds of attachment reach a comment:
 *   - a Media object (med_…), uploaded through Community's own file path (server/comments/service.js
 *     uploadAttachment). Its bytes are at <media>/o/<id>.
 *   - a composer attachment (att_…), uploaded by the person through Media's composer uploader and named in
 *     the comment as { media_attachment_id }. Media owns it; Community asks Media (with its service token,
 *     naming the person) whether it exists and is the person's, keeps it with the comment, and stores what
 *     Media answers: the kind, the type, the poster, the playback (url, mime, ready), the length and the size.
 */
const MEDIA_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const ATTACHMENT_ID = /^att_[0-9A-HJKMNP-TV-Z]{26}$/;
const NAME_MAX = 255;

/** The kinds a comment may carry: an image, a video, an audio, a PDF or a text file. */
const KINDS = new Set(['image', 'video', 'audio', 'file']);

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

/**
 * The composer attachment a comment names: { media_attachment_id: 'att_…' }. Throws a 400 when the id is not
 * one, so a comment never carries something Community cannot ask Media about.
 */
function composerReference(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const id = String(value.media_attachment_id || '').trim();
    if (!ATTACHMENT_ID.test(id)) {
        const err = new Error('Each Media attachment must be named by its media_attachment_id');
        err.status = 400; err.code = 'comment.attachment_invalid'; throw err;
    }
    return { media_attachment_id: id };
}

/**
 * The kind a comment may carry. An image, a video and an audio are fine; a file only when it is a PDF or text.
 * Everything else (code, a binary nobody can read) is refused.
 */
function allowedKind(kind, mime) {
    const k = String(kind || '').trim();
    if (KINDS.has(k)) {
        if (k !== 'file') return k;
        const m = String(mime || '').split(';')[0].trim().toLowerCase();
        return m === 'application/pdf' || m.startsWith('text/') ? 'file' : null;
    }
    return null;
}

/** The kind of a stored attachment when Media does not name one (the old file path). */
function kindOf(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (m.startsWith('image/')) return 'image';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return 'file';
}

/**
 * What a comment's attachment looks like to everyone who may read the comment. It carries the kind and what
 * plays it, so Shared can show a player for a video: playback { url, mime, ready }, the poster, the length and
 * the size after the rotation is applied.
 */
function publicReference(row) {
    const out = {
        id: row.media_id, name: row.filename || 'file', media_type: row.mime || 'application/octet-stream',
        size: Number(row.size_bytes) || 0, storage: { provider: 'media', key: row.media_id },
        access: { readers: [row.owner_subject] }, read: { method: 'not_readable', reason: 'Attached to a comment.' },
        role: 'input',
        kind: row.kind || kindOf(row.mime),
        url: row.url || null,
        poster: row.poster || null,
        playback: null,
        duration_s: row.duration_s != null ? Number(row.duration_s) : null,
        width: row.width != null ? Number(row.width) : null,
        height: row.height != null ? Number(row.height) : null,
    };
    if (row.playback_url) {
        out.playback = { url: row.playback_url, mime: row.playback_mime || row.mime || 'application/octet-stream', ready: !!row.playback_ready };
    }
    return out;
}

module.exports = { MEDIA_ID, ATTACHMENT_ID, KINDS, cleanReference, composerReference, allowedKind, kindOf, publicReference };
