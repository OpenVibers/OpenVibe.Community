'use strict';
/**
 * Runs inside a Community release (its directory is the cwd): starts that release's own Live, Network
 * and Media mocks (test/helpers/mock-*.js), then the app as production runs it (pastes authority
 * community, the shared database at COMMUNITY_DB_PATH = N1_DB), seeds a thread, a paste and a comment
 * through the API, and prints one line `{"n1": { url, token, ids }}`. SIGTERM stops it.
 */
const http = require('http');
const path = require('path');

(async () => {
    const dir = process.cwd();
    console.warn = () => {};
    const mockLive = require(path.join(dir, 'test', 'helpers', 'mock-live'));
    const mockNetwork = require(path.join(dir, 'test', 'helpers', 'mock-network'));
    const mockMedia = require(path.join(dir, 'test', 'helpers', 'mock-media'));
    const liveSrv = await mockLive.start();
    const net = await mockNetwork.start();
    const mediaSrv = await mockMedia.start({ publicPem: net.publicPem, issuer: net.url });
    Object.assign(process.env, {
        NODE_ENV: 'test',
        BASE_URL: 'https://openvibe.community',
        OV_LIVE_INTERNAL_URL: liveSrv.url,
        OV_LIVE_URL: 'https://openvibe.live',
        OV_MEDIA_URL: 'https://openvibe.media',
        OV_NETWORK_URL: net.url,
        OV_NETWORK_INTERNAL_URL: net.url,
        OV_OAUTH_CLIENT_ID: 'community',
        OV_OAUTH_CLIENT_SECRET: 'shh',
        OV_OAUTH_REDIRECT_URI: 'https://openvibe.community/auth/callback',
        COOKIE_SECURE: 'true',
        TRUST_PROXY: '1',
        OV_MEDIA_INTERNAL_URL: mediaSrv.url,
        PASTES_AUTHORITY: 'community',
        COMMUNITY_DB_PATH: process.env.N1_DB,
    });
    const { createApp } = require(path.join(dir, 'server', 'app'));
    const app = createApp({
        pasteLimits: { cooldownSeconds: 0 },
        forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 },
        commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
    });
    const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;

    const star = net.addUser({ network_user_id: 7, username: 'n1star', display_name: 'N1 Star' });
    const token = net.sign({ id: 7, subject_id: star.subject_id, username: 'n1star', display_name: 'N1 Star', role: 'user' });
    const call = async (p, { method = 'GET', json } = {}) => {
        const res = await fetch(url + p, { method, headers: { cookie: `ov_token=${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : undefined });
        let body = null; try { body = await res.json(); } catch { /* */ }
        if (!res.ok) process.stderr.write(`[n-1] seed ${method} ${p}: ${res.status} ${JSON.stringify(body).slice(0, 200)}\n`);
        return body || {};
    };
    const thread = (await call('/api/v1/spaces/general/threads', { method: 'POST', json: { title: 'N-1 thread', body: 'Seeded for the N-1 test' } })).thread;
    if (thread) await call(`/api/v1/threads/${thread.id}/posts`, { method: 'POST', json: { body: 'A reply from N-1' } });
    const paste = (await call('/api/pastes', { method: 'POST', json: { title: 'N-1 paste', content: 'console.log("n-1")', language: 'javascript' } })).paste;
    const ref = { service: 'live', type: 'stream', id: '123' };
    const commentThread = (await call('/api/v1/comments/threads/resolve', { method: 'POST', json: { ref } })).thread;
    if (commentThread) await call(`/api/v1/comments/threads/${commentThread.id}/comments`, { method: 'POST', json: { body: 'A comment from N-1' } });

    process.on('SIGTERM', () => { server.close(); try { require(path.join(dir, 'server', 'db')).closeDb(); } catch { /* */ } process.exit(0); });
    process.stdout.write(`${JSON.stringify({ n1: { url, token, ids: { thread: thread && thread.id, thread_slug: thread && thread.slug, paste: paste && paste.slug, comment_thread: commentThread && commentThread.id, comment_access: commentThread && (commentThread.access_id || commentThread.id) } } })}\n`);
})().catch((err) => { process.stderr.write(`${err.stack || err.message}\n`); process.exit(1); });
