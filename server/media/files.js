'use strict';

/**
 * OpenVibe.Media file store client — where new screenshot bytes go.
 *
 * Community keeps only the link: an upload is POSTed as multipart (field `file`) to Media's
 * community file store with a service token (capability media.object.upload), and Media answers
 * { key, url, size, mime }. The paste stores the absolute public URL and a transitional media
 * reference `legacy:community:file:<key>`. Imported pastes keep their existing Media screenshot
 * URLs; no bytes are ever copied here.
 */
const { serviceAuth, ids } = require('openvibe-contracts');

function createMediaFiles({ config, fetchImpl = globalThis.fetch } = {}) {
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media',
        scope: 'media.object.upload',
        fetchImpl,
    });
    const absolute = (u) => (/^https?:\/\//i.test(u) ? u : `${config.mediaUrl}${u.startsWith('/') ? '' : '/'}${u}`);

    /** Upload one file. → { key, url (absolute), size, mime, media_ref } */
    async function upload({ buffer, filename, mime }, retried = false) {
        const fd = new FormData();
        fd.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'upload.bin');
        const res = await fetchImpl(`${config.mediaInternalUrl}/api/v1/community/files`, {
            method: 'POST',
            headers: { Accept: 'application/json', ...(await tokens.authHeaders()) },
            body: fd,
            signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 401 && !retried) { tokens.invalidate(); return upload({ buffer, filename, mime }, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.key || !data.url) {
            const err = new Error(`Media upload ${res.status}: ${(data && (data.detail || data.error)) || 'bad response'}`);
            err.status = res.status;
            throw err;
        }
        return { key: data.key, url: absolute(data.url), size: data.size, mime: data.mime, media_ref: ids.legacyMediaId('community', 'file', data.key) };
    }

    return { upload, tokens };
}

module.exports = { createMediaFiles };
