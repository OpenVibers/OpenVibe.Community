'use strict';
/**
 * A stand-in for OpenVibe.Media's file store: POST /api/v1/community/files (multipart `file`)
 * with a Network service token for openvibe.media holding media.object.upload. Keeps each
 * upload's raw bytes so tests can check what left Community.
 */
const http = require('http');
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

function start({ publicPem, issuer }) {
    const uploads = [];
    let failNext = false;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.method !== 'POST' || req.url !== '/api/v1/community/files') return json(404, { error: 'not found' });
            const v = serviceAuth.verifyServiceToken(String(req.headers.authorization || '').slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.media' });
            if (!v.ok) return json(401, { code: v.code, error: v.reason });
            if (!(v.claims.cap || []).includes('media.object.upload')) return json(403, { code: 'capability.denied', error: 'not granted' });
            if (failNext) { failNext = false; return json(500, { error: 'disk full' }); }
            const body = Buffer.concat(chunks);
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
        uploads,
        failNext: () => { failNext = true; },
        close: () => new Promise((r) => server.close(r)),
    })));
}

module.exports = { start };
