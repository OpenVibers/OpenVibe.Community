'use strict';
/** /api/pastes/* is a transparent proxy to Live that forwards the visitor's identity and address. */
const assert = require('assert');
const { Readable } = require('stream');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot();

    await check('GET forwards path, query, the ov_token cookie as Bearer and the client address', async () => {
        const r = await t.get('/api/pastes/echo/thing?limit=5&x=y', { cookies: ['ov_token=cookie-jwt'], headers: { 'x-forwarded-for': '203.0.113.9' } });
        assert.strictEqual(r.status, 200);
        const e = r.json();
        assert.strictEqual(e.path, '/api/pastes/echo/thing');
        assert.deepStrictEqual(e.query, { limit: '5', x: 'y' });
        assert.strictEqual(e.headers.authorization, 'Bearer cookie-jwt');
        assert.strictEqual(e.headers['x-forwarded-for'], '203.0.113.9');
        assert.strictEqual(e.headers.cookie, undefined, 'cookies never leave this site');
    });

    await check('Authorization header wins over the cookie; anonymous calls carry no Authorization', async () => {
        const r = await t.get('/api/pastes/echo/x', { cookies: ['ov_token=cookie-jwt'], headers: { authorization: 'Bearer header-jwt' } });
        assert.strictEqual(r.json().headers.authorization, 'Bearer header-jwt');
        const anon = await t.get('/api/pastes/echo/x');
        assert.strictEqual(anon.json().headers.authorization, undefined);
    });

    await check('JSON POST body reaches Live byte-for-byte with its content-type', async () => {
        const body = JSON.stringify({ title: 't', content: 'hello', language: 'text' });
        const r = await t.get('/api/pastes', { method: 'POST', body, headers: { 'content-type': 'application/json' }, cookies: ['ov_token=good-token'] });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json().slug, 'new-paste-99');
        const call = t.live.calls.filter((c) => c.method === 'POST' && c.path === '/api/pastes').pop();
        assert.strictEqual(call.body.toString(), body);
        assert.strictEqual(call.headers['content-type'], 'application/json');
        assert.strictEqual(call.headers.authorization, 'Bearer good-token');
    });

    await check('multipart screenshot upload streams through untouched', async () => {
        const boundary = 'xxBOUNDARYxx';
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nShot\r\n--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
            png, Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const r = await t.get('/api/pastes/screenshot', { method: 'POST', body: Readable.from([body]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) } });
        assert.strictEqual(r.status, 201);
        assert.strictEqual(r.json().received, body.length);
        const call = t.live.calls.filter((c) => c.path === '/api/pastes/screenshot').pop();
        assert.ok(call.body.equals(body), 'body identical');
        assert.strictEqual(call.headers['content-type'], `multipart/form-data; boundary=${boundary}`);
    });

    await check('upstream status codes and error bodies pass through (404, 429)', async () => {
        const nf = await t.get('/api/pastes/does-not-exist');
        assert.strictEqual(nf.status, 404);
        assert.deepStrictEqual(nf.json(), { error: 'Paste not found' });
        const rl = await t.get('/api/pastes', { method: 'POST', body: JSON.stringify({ title: 'slow down', content: 'x' }), headers: { 'content-type': 'application/json' } });
        assert.strictEqual(rl.status, 429);
        assert.strictEqual(rl.json().cooldown, 30);
    });

    await check('DELETE and the copy/like sub-routes are forwarded with the method intact', async () => {
        const del = await t.get('/api/pastes/amber-fox-42', { method: 'DELETE', cookies: ['ov_token=good-token'] });
        assert.strictEqual(del.json().method, 'DELETE');
        const copy = await t.get('/api/pastes/amber-fox-42/copy', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        assert.strictEqual(copy.json().path, '/api/pastes/amber-fox-42/copy');
    });

    await check('an unreachable Live answers 502 JSON instead of hanging', async () => {
        const { createApp } = require('../server/app');
        const http = require('http');
        const app = createApp({ liveUrl: 'http://127.0.0.1:1' });
        const srv = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
        const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/pastes`);
        assert.strictEqual(res.status, 502);
        assert.deepStrictEqual(await res.json(), { error: 'Could not reach the paste service' });
        await new Promise((r) => srv.close(r));
    });

    await t.close();
    done();
})();
