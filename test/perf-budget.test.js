'use strict';
// Size budgets for openvibe.community's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the server as
// it runs (a fresh database), measured without a browser. Budgets sit a little above the 2026-09-26
// measurement; raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

const BUDGETS = {
    htmlRawKB: 26,   // measured 22.0 (fresh database; the showcase home)
    htmlBrotliKB: 6.5,   // 5.7
    jsFiles: 7,   // 6: openvibe-shared/shell adds web-runtime.js (raised with the shell, 2026-10-04)
    jsRawKB: 265,   // 251.3 (was 208.8 before the shell's web-runtime.js)
    jsBrotliKB: 64,   // 59.9 (was 48.9)
    cssFiles: 3,   // 2
    cssRawKB: 40,   // 36.5: community.css + the network's cached showcase.css (raised with the showcase home)
    cssBrotliKB: 8.5,   // 7.7
    externalFiles: 2,   // 1
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 150 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
