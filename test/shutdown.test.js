'use strict';
/**
 * Graceful stop (roadmap WS-P lifecycle; server/graceful.js), on the real process with the events
 * outbox, the Discord relay, the Pulse subscriptions and the profile and search scans all on (pointed
 * at nothing): SIGTERM while a request is in flight and a keep-alive connection sits idle. New
 * connections are refused, the request is answered (Connection: close), every background worker is
 * stopped, community.db is closed, and the process exits 0 within the manifest's 5 s; the idle
 * keep-alive connection (65 s otherwise) does not hold the stop.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-community-stop-'));
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', COMMUNITY_DB_PATH: path.join(dir, 'community.db'),
            EVENTS_URL: 'http://127.0.0.1:9', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9', OV_NETWORK_URL: 'http://127.0.0.1:9',
            OV_OAUTH_CLIENT_SECRET: 'test-secret-not-real', COMMUNITY_EVENTS_SECRET: 'e'.repeat(40), DISCORD_RELAY_ENABLED: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await sleep(100);
        }
        assert.ok(up, `the server did not start:\n${out}`);
        assert.match(out, /\[Events\] community →/, 'the outbox is on');

        // An idle keep-alive connection (the server keeps them 65 s).
        const agent = new http.Agent({ keepAlive: true });
        await new Promise((resolve, reject) => http.get(`${base}/api/health`, { agent }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));

        // A request in flight: POST /internal/events reads its whole body before it answers.
        const body = Buffer.from(JSON.stringify({ probe: 'graceful-stop', pad: 'x'.repeat(64) }));
        const req = http.request({ host: '127.0.0.1', port, path: '/internal/events', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } });
        const answered = new Promise((resolve, reject) => {
            req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, at: Date.now() })); });
            req.on('error', reject);
        });
        req.write(body.subarray(0, 10));
        await sleep(200);

        const t0 = Date.now();
        child.kill('SIGTERM');
        await sleep(300);
        const refused = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => false, () => true);
        assert.ok(refused, 'no new connections once stopping');
        req.end(body.subarray(10));
        const r = await answered;
        assert.ok(r.at > t0, 'the request was still in flight at SIGTERM');
        assert.strictEqual(r.status, 401, 'answered (an unsigned delivery), not cut');
        assert.strictEqual(r.connection, 'close');

        const { code, signal } = await exited;
        const ms = Date.now() - t0;
        assert.strictEqual(code, 0, `exit 0 (got ${code} ${signal})\n${out.slice(-2000)}`);
        assert.ok(ms < 5000, `within the manifest's 5 s (${ms} ms)`);
        assert.match(out, /\[Community\] stopped: subscriptions stopped, profile scan stopped, search scans stopped, relay stopped, outbox stopped \(\d+ pending\)/, out.slice(-2000));
        assert.match(out, /\[Community\] stopped in \d+ ms/);
        agent.destroy();
        console.log(`shutdown: SIGTERM → exit 0 in ${ms} ms, the request in flight answered, every worker stopped`);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
