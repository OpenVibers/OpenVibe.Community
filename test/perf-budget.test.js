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
    htmlRawKB: 43,   // 42.3 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 41.9 the phone home (2026-10-30: the roadmap and the pulse become chips and the questions a fold); 39.4 the short home (2026-10-29: rails, a launcher and a fold in place of three grids, What lives here, Part of OpenVibe and the closing call), lowered back from 42; 41.6 with the agent layer's two discovery <link> tags (Shared 4.34.0, 2026-10-29); was 41 at 41.0
                     // 36.4 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); measured 31.7 on 10-22: the home gained the forum's places, the roadmap, Pulse, real counts and six
                     // questions with their FAQPage JSON-LD; was 26 at 22.0
    htmlBrotliKB: 10.3,   // 10.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 8.6 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 7.3 on 10-22 (the same shelves); was 6.5 at 5.7
    jsFiles: 7,   // 6: openvibe-shared/shell adds web-runtime.js (raised with the shell, 2026-10-04)
    jsRawKB: 340,   // 339.1 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 338.3 with openvibe-shared 4.64.0: the look travels between sites, the Look panel in the menu (2026-10-31); 337.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 335.4 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 332.4 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 329.8 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 322 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 314 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 306.5 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 300.7 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 286.6 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 276.8 with shared 4.11.0's seasonal navbar; 267.5 with openvibe-shared 4.9.0 (status text twins in every theme, 2026-10-23); 251.3 (was 208.8 before the shell's web-runtime.js)
    jsBrotliKB: 84,   // 83.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 82.3 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 81.7 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 80.2 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 78.1 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 74.4 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 71.7 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 69.1 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 65.5 with shared 4.11.0's seasonal navbar; 59.9 (was 48.9)
    cssFiles: 5,   // 5 the short home: + kit.css (numbers, lists, chips, the fold) and room.css (cards and rails), the shared kit's look; 3
    cssRawKB: 120,   // 117.7 openvibe-shared 4.71.0 (2026-11-01: the navbar in OpenVibe glyphs, the icons setting); 114.3 with openvibe-shared 4.62.0: the shared sidebar in kit.css, the glyphs and their fonts (2026-10-31); 109.0 the phone home (2026-10-30: the chips and the fold rules); 104.8 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 102.6 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 97.3 the short home (2026-10-29): kit.css 25.6 KB + room.css 15.7 KB, while community.css sheds the old shelves' rules and the page 10 of its 15 phone screens; 54.9 openvibe-shared 4.26.1 (hero visual); 47.2 with Shared 4.13.0 (2026-10-26); 40.6 on 10-22 (the home shelves' styles in community.css); was 40 at 36.5 with the showcase home
    cssBrotliKB: 25,   // 23.8 with openvibe-shared 4.62.0: the shared sidebar in kit.css, the glyphs and their fonts (2026-10-31); 22.1 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 21.7 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 20.4 the short home (kit.css + room.css, as above; was 11.5 once Kit 2 had its own files in openvibe-shared v4.37.0); 9.5 with Shared 4.13.0 (2026-10-26); 7.7 // raised 11 -> 12 for the openvibe-shared Kit 2 pin (kit.css grew)
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
