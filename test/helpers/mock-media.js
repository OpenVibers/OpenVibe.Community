'use strict';
/**
 * A stand-in for OpenVibe.Media: the v1 file store (POST /api/v1/community/files, multipart `file`), image
 * normalization, and Object API v2 upload (POST /api/v2/community/objects → PUT /:id/content → POST /:id/complete), with a
 * Network service token for openvibe.media holding media.object.upload. Keeps each finished upload's raw
 * bytes (and, for v2, its kind, visibility and owner) so tests can check what left Community.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth, ids } = require('openvibe-contracts');

function start({ publicPem, issuer }) {
    const uploads = [];
    const deletes = [];             // v2 object ids a DELETE removed
    const pending = new Map();      // v2 objects between init and complete
    let failNext = false;
    let failNextDelete = false;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true, service: 'mock-media' });
            // A public object's bytes (a private one is reached through /download, below). ?w=&fmt= asks
            // for Media's resized variant: answer webp with the width in the body, as Media would.
            const open = req.url.match(/^\/o\/(med_[0-9A-Z]+)(\?[^#]*)?$/);
            if (open && req.method === 'GET') {
                const o = uploads.find((u) => u.key === open[1]);
                if (!o) return json(404, { error: 'not found' });
                const q = new URL(req.url, 'http://mock-media').searchParams;
                if (q.get('w')) {
                    res.writeHead(200, { 'Content-Type': 'image/webp' });
                    return res.end(Buffer.concat([Buffer.from(`WEBP-${q.get('w')}-${q.get('fmt') || 'webp'}`), o.bytes]));
                }
                res.writeHead(200, { 'Content-Type': o.mime }); return res.end(o.bytes);
            }
            const del = req.url.match(/^\/api\/v2\/community\/objects\/(med_[0-9A-Z]+)$/);
            if (del && req.method === 'DELETE') {
                const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.media' });
                if (!v.ok) return json(401, { code: v.code, error: v.reason });
                if (!(v.claims.cap || []).includes('media.object.delete')) return json(403, { code: 'capability.denied', error: 'not granted' });
                if (failNextDelete) { failNextDelete = false; return json(500, { error: 'delete failed' }); }
                const i = uploads.findIndex((u) => u.key === del[1]);
                if (i < 0) return json(404, { code: 'media.object.not_found' });
                uploads.splice(i, 1);
                deletes.push(del[1]);
                return json(200, { id: del[1], lifecycle_status: 'deleted' });
            }
            // GET /api/v2/community/objects/:id — the metadata Community reads to check a picture the person uploaded.
            const meta = req.url.match(/^\/api\/v2\/community\/objects\/(med_[0-9A-Z]+)(?:\?.*)?$/);
            if (meta && req.method === 'GET') {
                const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.media' });
                if (!v.ok) return json(401, { code: v.code, error: v.reason });
                if (!(v.claims.cap || []).includes('media.object.read')) return json(403, { code: 'capability.denied', error: 'not granted' });
                const o = uploads.find((u) => u.key === meta[1]);
                if (!o) return json(404, { code: 'media.object.not_found' });
                return json(200, { id: o.key, owner: { subject: o.owner || null, app: null }, lifecycle_status: 'ready',
                    mime_type: o.mime, size_bytes: (o.bytes || Buffer.alloc(0)).length, public_url: `http://127.0.0.1:${server.address().port}/o/${o.key}`,
                    metadata: { filename: o.name } });
            }
            const v2 = req.url.match(/^\/api\/v2\/community\/objects(?:\/(med_[0-9A-Z]+)\/(content|complete|download))?(?:\?.*)?$/);
            const normalize = req.method === 'POST' && req.url === '/api/v2/community/objects/normalize-image';
            if (!v2 && !normalize && (req.method !== 'POST' || req.url !== '/api/v1/community/files')) return json(404, { error: 'not found' });
            const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.media' });
            if (!v.ok) return json(401, { code: v.code, error: v.reason });
            const verb = v2 && req.method === 'GET' && v2[2] === 'download' ? 'media.object.read' : 'media.object.upload';
            if (!(v.claims.cap || []).includes(verb)) return json(403, { code: 'capability.denied', error: 'not granted' });
            const body = Buffer.concat(chunks);
            if (normalize) {
                const { stripImageMetadata } = require('../../server/media/strip-metadata');
                res.writeHead(200, { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' });
                return res.end(stripImageMetadata(body, req.headers['content-type']));
            }
            if (v2 && req.method === 'GET' && v2[2] === 'download') {
                const o = uploads.find((u) => u.key === v2[1]);
                if (!o) return json(404, { code: 'media.object.not_found' });
                // Private objects answer a short-lived URL of their own; the shape is what Community reads.
                return json(200, { url: `http://127.0.0.1:${server.address().port}/o/${o.key}`, public: o.visibility !== 'private' });
            }
            if (v2) {
                if (req.method === 'POST' && !v2[1]) {
                    if (failNext) { failNext = false; return json(500, { error: 'disk full' }); }
                    const b = JSON.parse(body.toString() || '{}');
                    const id = ids.newId('media');
                    pending.set(id, { ...b, owner: req.headers['x-ov-subject'] || null });
                    return json(201, { id, object: { id } });
                }
                const o = pending.get(v2[1]);
                if (!o) return json(404, { code: 'media.object.not_found' });
                if (req.method === 'PUT' && v2[2] === 'content') { o.bytes = body; o.mime = String(req.headers['content-type'] || ''); return json(200, { id: v2[1], size_bytes: body.length }); }
                if (req.method === 'POST' && v2[2] === 'complete') {
                    const hash = crypto.createHash('sha256').update(o.bytes || Buffer.alloc(0)).digest('hex');
                    if (hash !== o.content_hash) return json(400, { code: 'media.object.hash_mismatch' });
                    pending.delete(v2[1]);
                    uploads.push({ key: v2[1], name: o.filename || 'upload.bin', mime: o.mime, bytes: o.bytes, claims: v.claims, kind: o.kind, visibility: o.visibility, owner: o.owner, v2: true });
                    return json(200, { id: v2[1], lifecycle_status: 'ready' });
                }
                return json(404, { error: 'not found' });
            }
            if (failNext) { failNext = false; return json(500, { error: 'disk full' }); }
            // Pull the `file` part out of the multipart body.
            const m = String(req.headers['content-type']).match(/boundary=(?:"([^"]+)"|([^;]+))/);
            const boundary = m && (m[1] || m[2]);
            const parts = body.toString('latin1').split(`--${boundary}`);
            const part = parts.find((p) => /name="file"/.test(p)) || '';
            const headerEnd = part.indexOf('\r\n\r\n');
            const head = part.slice(0, headerEnd);
            const bytes = Buffer.from(part.slice(headerEnd + 4, part.length - 2), 'latin1');
            const name = (head.match(/filename="([^"]*)"/) || [])[1] || 'upload.bin';
            const mime = ((head.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] || 'application/octet-stream').trim();
            const key = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)}-${name}`;
            uploads.push({ key, name, mime, bytes, claims: v.claims });
            json(201, { key, url: `/f/${key}`, size: bytes.length, mime });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        uploads, deletes,
        failNext: () => { failNext = true; },
        failNextDelete: () => { failNextDelete = true; },
        close: () => new Promise((r) => server.close(r)),
    })));
}

module.exports = { start };
