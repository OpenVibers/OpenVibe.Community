'use strict';
/**
 * A stand-in for OpenVibe.Network: JWKS + the token endpoint, with a real RS256 key pair.
 *
 * Also the Wave-1 service-principal surface Community uses in 'community' authority mode:
 *   - client_credentials grants (form-encoded, as openvibe-contracts' token client sends them)
 *     mint service tokens with the requested audience and scope as capabilities;
 *   - POST /internal/identity/resolve-batch answers from `directory` and insists on a service
 *     token for openvibe.network holding identity.subject.resolve.
 * signService() mints tokens as another service (e.g. Live) would present them to Community.
 */
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');

function start() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const grants = [];
    const resolveCalls = [];
    let issuer = 'http://network.test';

    // Network accounts: { network_user_id, subject_id, username, display_name, avatar_url }, plus
    // legacy ids other services registered: legacy[system][id] = subject_id.
    const directory = { users: [], legacy: { live: {} }, down: false };
    function addUser(u) {
        const user = { subject_id: ids.newId('user'), display_name: u.username, avatar_url: null, ...u };
        directory.users.push(user);
        return user;
    }
    const projection = (u) => (u ? { subject: { type: 'user', id: u.subject_id }, network_user_id: u.network_user_id, username: u.username, display_name: u.display_name, avatar_url: u.avatar_url, banned: false } : null);

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/api/.well-known/jwks') return json(200, { public_key: publicPem, algorithm: 'RS256' });
            if (req.url === '/oauth/token' && req.method === 'POST') {
                let body = {};
                if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
                else { try { body = JSON.parse(raw); } catch { /* */ } }
                grants.push(body);
                if (body.client_secret !== 'shh') return json(401, { error: 'invalid_client' });
                if (body.grant_type === 'client_credentials') {
                    const cap = String(body.scope || '').split(/\s+/).filter(Boolean);
                    return json(200, { access_token: signService({ sub: `svc:${body.client_id}`, aud: [body.audience], cap }), token_type: 'Bearer', expires_in: 300 });
                }
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
            if (req.url === '/internal/identity/resolve-batch' && req.method === 'POST') {
                const auth = String(req.headers.authorization || '');
                const v = serviceAuth.verifyServiceToken(auth.slice(7), { publicKey: publicPem, issuer, audience: 'openvibe.network' });
                if (!v.ok) return json(401, { code: v.code, error: v.reason });
                if (!(v.claims.cap || []).includes('identity.subject.resolve')) return json(403, { code: 'capability.denied', error: 'not granted' });
                let body = {}; try { body = JSON.parse(raw); } catch { /* */ }
                resolveCalls.push(body);
                if (directory.down) return json(503, { error: 'down' });
                const results = {};
                if (Array.isArray(body.subject_ids)) {
                    for (const s of body.subject_ids) results[s] = projection(directory.users.find((u) => u.subject_id === s));
                } else {
                    for (const id of body.ids || []) {
                        const k = String(id);
                        if (body.system === 'network') results[k] = projection(directory.users.find((u) => String(u.network_user_id) === k));
                        else {
                            const sid = (directory.legacy[body.system] || {})[k];
                            results[k] = projection(sid ? directory.users.find((u) => u.subject_id === sid) : null);
                        }
                    }
                }
                return json(200, { results });
            }
            json(404, { error: 'not found' });
        });
    });
    function sign(claims, opts = {}) {
        return jwt.sign({ sub: claims.id, ...claims }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h', ...opts });
    }
    /** A client-credentials service token (identity.service-token-claims@1). */
    function signService({ sub = 'svc:live', actorType = 'service', aud = ['openvibe.community'], cap = [], iss = issuer, expSec = 300, key = privatePem, extra = {} } = {}) {
        const now = Math.floor(Date.now() / 1000);
        return serviceAuth.signServiceToken({ iss, sub, actor_type: actorType, aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex'), ...extra }, key);
    }
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        issuer = url;
        resolve({ url, grants, resolveCalls, directory, addUser, sign, signService, publicPem, close: () => new Promise((r) => server.close(r)) });
    }));
}

module.exports = { start };
