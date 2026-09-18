'use strict';
/** A stand-in for OpenVibe.Network: JWKS + the token endpoint, with a real RS256 key pair. */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

function start() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const grants = [];
    let issuer = 'http://network.test';
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
            if (req.url === '/oauth/token' && req.method === 'POST') {
                let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
                grants.push(body);
                if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
                if (body.grant_type === 'authorization_code' && body.code !== 'good-code') return json(400, { error: 'invalid_grant' });
                if (body.grant_type === 'refresh_token' && body.refresh_token !== 'refresh-1') return json(400, { error: 'invalid_grant' });
                if (body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
                    // A FedCM assertion: must be one of ours (signed with our key) and carry a nonce.
                    try { const a = jwt.verify(body.assertion, publicPem, { algorithms: ['RS256'] }); if (!a.nonce) throw new Error('no nonce'); }
                    catch (e) { return json(400, { error: 'invalid_grant', error_description: `assertion rejected: ${e.message}` }); }
                }
                const user = { id: 7, username: 'alex', display_name: 'Alex', role: 'user' };
                return json(200, { access_token: sign(user), refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 86400, user, preferences: { theme: 'vibe' } });
            }
            if (req.url === '/oauth/revoke') return json(200, { ok: true });
            json(404, { error: 'not found' });
        });
    });
    function sign(claims, opts = {}) {
        return jwt.sign({ sub: claims.id, ...claims }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h', ...opts });
    }
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        issuer = url;
        resolve({ url, grants, sign, publicPem, close: () => new Promise((r) => server.close(r)) });
    }));
}

module.exports = { start };
