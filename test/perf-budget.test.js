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
    htmlRawKB: 35,   // measured 31.7 on 10-22: the home gained the forum's places, the roadmap, Pulse, real counts and six
                     // questions with their FAQPage JSON-LD; was 26 at 22.0
    htmlBrotliKB: 8.1,   // 7.3 on 10-22 (the same shelves); was 6.5 at 5.7
    jsFiles: 7,   // 6: openvibe-shared/shell adds web-runtime.js (raised with the shell, 2026-10-04)
    jsRawKB: 281,   // 276.8 with shared 4.11.0's seasonal navbar; 267.5 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 251.3 (was 208.8 before the shell's web-runtime.js)
    jsBrotliKB: 67,   // 65.5 with shared 4.11.0's seasonal navbar; 59.9 (was 48.9)
    cssFiles: 3,   // 2
    cssRawKB: 43,   // 40.6 on 10-22 (the home shelves' styles in community.css); was 40 at 36.5 with the showcase home
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
