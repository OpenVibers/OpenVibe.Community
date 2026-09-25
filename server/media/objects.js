'use strict';

/**
 * OpenVibe.Media Object API v2 client — attachments on forum posts (WS-J task 2). Community keeps a
 * `med_` reference and the public URL; the bytes live in Media under the `community` tenant, owned by
 * the person who attached them (X-OV-Subject), with Community's service token (media.object.upload,
 * namespace community):
 *
 *   POST /api/v2/community/objects                 init { kind: 'file', visibility: 'public', size_bytes, mime_type, filename, content_hash }
 *   PUT  /api/v2/community/objects/:id/content     the bytes
 *   POST /api/v2/community/objects/:id/complete    Media checks size, hash and type → ready
 *
 * Public bytes are served at <media>/o/:id.
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

function createMediaObjects({ config, fetchImpl = globalThis.fetch } = {}) {
    const configured = !!(config.oauth && config.oauth.clientSecret);
    const tokens = configured ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.media',
        scope: 'media.object.upload',
        fetchImpl,
    }) : null;
    const base = `${config.mediaInternalUrl}/api/v2/community/objects`;

    async function call(method, path, { json, body, headers = {} } = {}, retried = false) {
        const h = { Accept: 'application/json', ...headers, ...(await tokens.authHeaders()) };
        if (json !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal: AbortSignal.timeout(60_000) });
        if (res.status === 401 && !retried) { tokens.invalidate(); return call(method, path, { json, body, headers }, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Media ${method} ${path || '/'} ${res.status}: ${(data && (data.detail || data.error)) || 'failed'}`);
            err.status = res.status; err.code = data && data.code;
            throw err;
        }
        return data || {};
    }

    /** Store one image for `owner` (usr_…). → { id (med_…), url, size_bytes, mime } */
    async function uploadImage({ buffer, mime, filename, owner }) {
        if (!configured) { const e = new Error('Attachments need Community\'s service principal (OV_OAUTH_CLIENT_SECRET)'); e.status = 503; throw e; }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const init = await call('POST', '', {
            json: { kind: 'file', visibility: 'public', size_bytes: buffer.length, mime_type: mime, filename, content_hash: sha256, metadata: { source: 'community.attachment' } },
            headers: { 'X-OV-Subject': owner },
        });
        const id = init.id || (init.object && init.object.id);
        if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw Object.assign(new Error('Media returned no object id'), { status: 502 });
        await call('PUT', `/${id}/content`, { body: buffer, headers: { 'Content-Type': mime } });
        await call('POST', `/${id}/complete`, { json: { content_hash: sha256 } });
        return { id, url: `${config.mediaUrl}/o/${id}`, size_bytes: buffer.length, mime };
    }

    return { configured, uploadImage };
}

module.exports = { createMediaObjects };
