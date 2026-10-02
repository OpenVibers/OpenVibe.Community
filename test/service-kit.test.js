'use strict';
// Check the SDK graceful stop primitive used by Community. shutdown.test.js covers
// the wiring and shutdown behavior on the real server.
//   node test/service-kit.test.js
const assert = require('assert');
const http = require('http');
const { gracefulStop, within } = require('openvibe-sdk/service');

(async () => {
    const server = http.createServer((req, res) => { res.end('ok'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const order = [];
    let code = null;
    const { stop, stopping } = gracefulStop({
        name: 'ServiceKit', server, drainMs: 4000, deadlineMs: 5000, deadlineExitCode: 1, signals: false,
        exit: (c) => { code = c; },
        stop: [() => order.push('stop:one'), async () => order.push('stop:two')],
        close: [() => order.push('close:one'), async () => order.push('close:two')],
    });
    assert.strictEqual(stopping(), false, 'not stopping before the signal');
    const stopped = await stop('SIGTERM');
    assert.deepStrictEqual(order, ['stop:one', 'stop:two', 'close:one', 'close:two'], 'the stop then close steps run in order');
    assert.strictEqual(code, 0, 'a clean stop exits 0');
    assert.strictEqual(stopped, 0, 'stop() resolves with the exit code');
    assert.strictEqual(stopping(), true, 'stopping() is true once stop() has run');

    // within() bounds a step and swallows its rejection (a best-effort stop step is never a reason to fail the stop).
    // gracefulStop closed the server above, so keep the loop alive while the unref'd within timer fires.
    const keepAlive = setInterval(() => {}, 1000);
    const t0 = Date.now();
    await within(50, new Promise(() => {}));
    assert.ok(Date.now() - t0 < 2000, 'within returns at its bound');
    await within(50, Promise.reject(new Error('a slow step rejected')));
    clearInterval(keepAlive);

    console.log('service-kit: all checks passed');
})().catch((err) => { console.error(err); process.exitCode = 1; });
