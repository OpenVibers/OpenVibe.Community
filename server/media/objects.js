'use strict';

/**
 * OpenVibe.Media Object API v2 client — images on forum posts (WS-J task 2) and screenshot pastes. Community keeps a
 * `med_` reference and the public URL; the bytes live in Media under the `community` tenant, owned by
 * the person who attached them (X-OV-Subject), with Community's service token (media.object.upload,
 * namespace community):
 *
 *   POST /api/v2/community/objects                 init { kind, visibility: 'unlisted', size_bytes, mime_type, filename, content_hash }
 *   PUT  /api/v2/community/objects/:id/content     the bytes
 *   POST /api/v2/community/objects/:id/complete    Media checks size, hash and type → ready
 *   DELETE /api/v2/community/objects/:id           soft delete (this tenant only; a legacy Live paste answers 404)
 *   POST /internal/community/legacy-paste-screenshots/:id/retire
 *                                                  the legacy:live:paste:<slug> screenshot in Media's live tenant
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
        scope: 'media.object.upload media.object.read media.object.delete',
        fetchImpl,
    }) : null;
    const base = `${config.mediaInternalUrl}/api/v2/community/objects`;

    async function request(method, url, { json, body, headers = {} } = {}, retried = false) {
        const h = { Accept: 'application/json', ...headers, ...(await tokens.authHeaders()) };
        if (json !== undefined) h['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, signal: AbortSignal.timeout(60_000) });
        if (res.status === 401 && !retried) { tokens.invalidate(); return await request(method, url, { json, body, headers }, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Media ${method} ${url.replace(/^https?:\/\/[^/]+/, '')} ${res.status}: ${(data && (data.detail || data.error)) || 'failed'}`);
            err.status = res.status; err.code = data && data.code;
            throw err;
        }
        return data || {};
    }

    async function call(method, path, opts = {}) {
        return await request(method, `${base}${path}`, opts);
    }

    /**
     * Store one image. → { id (med_…), url, size_bytes, mime }
     * owner: the person (usr_…) the object belongs to, when there is one; kind: 'file' (post images) or
     * 'screenshot' (screenshot pastes); visibility 'unlisted': served to anyone with the link (the object id is
     * unguessable), never listed on openvibe.media — the post or paste decides who sees the link.
     */
    async function uploadImage({ buffer, mime, filename, owner = null, kind = 'file', visibility = 'unlisted', source = 'community.attachment' }) {
        if (!configured) { const e = new Error('Attachments need Community\'s service principal (OV_OAUTH_CLIENT_SECRET)'); e.status = 503; throw e; }
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const init = await call('POST', '', {
            json: { kind, visibility, size_bytes: buffer.length, mime_type: mime, filename, content_hash: sha256, metadata: { source } },
            headers: /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(owner || '')) ? { 'X-OV-Subject': owner } : {},
        });
        const id = init.id || (init.object && init.object.id);
        if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) throw Object.assign(new Error('Media returned no object id'), { status: 502 });
        await call('PUT', `/${id}/content`, { body: buffer, headers: { 'Content-Type': mime } });
        await call('POST', `/${id}/complete`, { json: { content_hash: sha256 } });
        return { id, url: `${config.mediaUrl}/o/${id}`, size_bytes: buffer.length, mime };
    }

    /**
     * A usable URL for one object's bytes: its public address, or a short-lived signed URL for a private
     * object. Used by Community's screenshot proxy, which checks canView before asking.
     */
    async function downloadUrl(id, retried = false) {
        try {
            const out = await call('GET', `/${encodeURIComponent(String(id))}/download?format=json`);
            return out && out.url ? out.url : null;
        } catch (err) {
            if (err.status === 401 && !retried) { tokens.invalidate(); return await downloadUrl(id, true); }
            throw err;
        }
    }

    /**
     * Soft-delete one object from Media (a screenshot's old unlisted copy after it moved private).
     * Needs media.object.delete in the community tenant. A 404 is NOT "already gone": Media answers
     * it for an object outside the caller's tenant (a legacy Live paste, media.object.legacy_managed
     * on the direct route), and the move script must keep the reference and retire that object
     * through retireLegacyPaste instead. An older Community v1 file is in this tenant and answers
     * 409 media.object.legacy_managed; the move script retires it the same way, after its reference
     * check.
     */
    async function deleteObject(id) {
        await call('DELETE', `/${encodeURIComponent(String(id))}`);
        return { deleted: true };
    }

    /**
     * Retire one legacy object through Media's internal route: a Live paste screenshot in the live
     * tenant (deleteObject answers 404) or a Community v1 file in this tenant (deleteObject answers
     * 409 media.object.legacy_managed). Media accepts those two legacy shapes only, only for
     * Community's service principal; a repeat is a no-op (changed:false). Needs media.object.delete.
     */
    async function retireLegacyPaste(id) {
        if (!configured) { const e = new Error('Retiring a Media object needs Community\'s service principal (OV_OAUTH_CLIENT_SECRET)'); e.status = 503; throw e; }
        const out = await request('POST', `${config.mediaInternalUrl}/internal/community/legacy-paste-screenshots/${encodeURIComponent(String(id))}/retire`);
        return { retired: true, changed: !!(out && out.changed), ...(out && out.retention_until ? { retention_until: out.retention_until } : {}) };
    }

    return { configured, uploadImage, downloadUrl, deleteObject, retireLegacyPaste };
}

module.exports = { createMediaObjects };
