'use strict';
// The Community composer on the shared one (openvibe-shared 4.215.0, OpenVibeComposer.mount): a marked server form
// keeps its action, title, paste field and no-JS submit; its words become form.ovc-v2[data-preset] and the form
// still posts. Real Chrome at 390 px; skipped without Chrome.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const h = require('openvibe-shared/browser-harness');
if (process.env.OV_SKIP_BROWSER === '1' || !h.findChrome()) { console.log('composer: skipped (no Chrome; set CHROME_BIN)'); process.exit(0); }
const SHARED = process.env.OV_SHARED_DIR || path.join(__dirname, '..', 'node_modules', 'openvibe-shared');
const SITE = path.join(__dirname, '..');
const reply = `<form class="paste-form reply-form" method="post" action="/forum/general/t/reply" data-ovc-compose data-ovc-preset="comment" data-ovc-user='{"display_name":"Alex"}'>
<p class="alert alert-error" role="alert">A problem</p>
<label class="field"><span>Reply (Markdown)</span><textarea name="body" rows="7" maxlength="40000" required placeholder="Say it, own it."></textarea></label>
<label class="field"><span>Pastes</span><input type="text" name="pastes" value="https://openvibe.community/p/x"></label>
<div class="form-actions"><button class="btn btn-primary" type="submit">Post reply</button><span class="muted small">**bold**, *italic*</span></div>
</form>`;
const fresh = `<form class="paste-form" method="post" action="/forum/general/new" data-ovc-compose data-ovc-preset="post" data-ovc-user='{"display_name":"Alex"}'>
<label class="field"><span>Title</span><input type="text" name="title" value="A title" required></label>
<label class="field"><span>Post (Markdown)</span><textarea name="body" rows="14" maxlength="40000" required placeholder="Say it, own it."></textarea></label>
<div class="form-actions"><button class="btn btn-primary" type="submit">Post thread</button></div>
</form>`;
let posted = '';
const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { posted = body; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><p id="posted">posted</p>'); });
        return;
    }
    if (req.url === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Composer</title><link rel="icon" href="data:,"></head><body style="margin:0;padding:16px;background:#0b1220;color:#e6edf7;font-family:sans-serif">${reply}${fresh}<script src="/ov-composer.js"></script><script src="/composer.js"></script></body></html>`);
    }
    if (req.url === '/ov-composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SHARED, 'ov-composer.js'))); }
    if (req.url === '/composer.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(SITE, 'public/js/composer.js'))); }
    res.writeHead(404); res.end();
});
(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-composer-'));
    const browser = await h.launch({ tmpDir });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const page = await h.openPage(browser, await browser.newContext(), { width: 390, height: 900 });
    try {
        await page.goto(base + '/', { maxMs: 6000 });
        for (let i = 0; i < 100 && !(await page.evaluate(`!!document.querySelector('form.ovc-v2')`)); i++) await wait(40);
        const shape = await page.evaluate(`(() => [...document.querySelectorAll('form[data-ovc-compose]')].map((f) => ({ cls: f.className, preset: f.dataset.preset, action: f.getAttribute('action'), text: !!f.querySelector('[data-ovt-text]'), old: !!f.querySelector('label.field textarea'), title: (f.querySelector('input[name=title]') || {}).value || null, send: f.querySelector('[data-ovt-send]').textContent.trim() })))()`);
        assert.deepEqual(shape.map((s) => [s.preset, s.action, s.text, s.old]), [['comment', '/forum/general/t/reply', true, false], ['post', '/forum/general/new', true, false]]);
        assert.ok(/ovc-v2/.test(shape[0].cls) && /ovt-composer/.test(shape[0].cls));
        assert.equal(shape[0].send, 'Post reply');
        assert.equal(shape[1].title, 'A title');
        assert.equal(await page.evaluate(`document.documentElement.scrollWidth`), 390, 'nothing is wider than a phone');
        await page.evaluate(`(() => { const f = document.querySelector('form[data-ovc-preset="comment"]'); const t = f.querySelector('textarea'); t.value = 'Hello from the shared box'; t.dispatchEvent(new Event('input', { bubbles: true })); f.querySelector('[data-ovt-send]').click(); })()`);
        for (let i = 0; i < 100 && !posted; i++) await wait(40);
        assert.ok(/body=Hello\+from\+the\+shared\+box/.test(posted) || /name="body"\r?\n\r?\nHello from the shared box/.test(posted), 'the words post under the form\'s own name');
        assert.ok(/pastes=/.test(posted), 'the form\'s other fields stay');
        console.log('composer: the reply and the new thread are the shared composer, keep their fields, send, 390 px');
    } finally {
        await page.close().catch(() => {});
        await browser.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
