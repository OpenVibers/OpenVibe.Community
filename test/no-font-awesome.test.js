'use strict';
// No Font Awesome (plan L54 K4; the owner, 2026-11-01: "get rid of Font Awesome completely and just use our own
// openvibe.design system"). OpenVibe.Community's icons are the OpenVibe glyphs (openvibe-shared/glyphs, drawn in the browser by
// /shared/ov-glyphs.js, which the Shared navbar loads on a page that names an icon) and the brand logos from
// openvibe-shared/brands. This holds it there:
//   - no page or stylesheet links Font Awesome, and nothing draws with Font Awesome's font;
//   - every page that names an icon loads the navbar or the glyph drop-in;
//   - every fa- name OpenVibe.Community uses is one the glyphs or the brands draw (a name nobody draws would show nothing).
//   node test/no-font-awesome.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const glyphs = require('openvibe-shared/glyphs');
const brands = require('openvibe-shared/brands');

const ROOT = path.join(__dirname, '..');
const walk = (dir, ok, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, ok, out); else if (ok.test(e.name)) out.push(p);
    }
    return out;
};
const rel = (p) => path.relative(ROOT, p);

// The pages (whole HTML files) and the code that draws them.
const PAGE_ROOTS = [];
const CODE_ROOTS = ["public","server"];
const LAYOUTS = ["server/render/layout.js"];   // the server-rendered pages: their layout brings the navbar or the glyphs

// A Font Awesome stylesheet, wherever it is written.
const FA_CSS = /fontawesome[^"'\s]*\.css|font-awesome[^"'\s]*\.css|cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/i;

const pages = [];
for (const r of PAGE_ROOTS) pages.push(...walk(path.join(ROOT, r), /\.html$/));
for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    assert.ok(!/fontawesome|font-awesome/i.test(html), `${rel(p)} links Font Awesome`);
    // A whole page (with a <head>; fragments are parts of a page) that names an icon loads what draws it.
    if (/<head[\s>]/i.test(html) && /\bfa-[a-z]/.test(html) && !/\/shared\/navbar|ov-glyphs\.js/.test(html)) {
        assert.fail(`${rel(p)} has fa- icons but loads neither the navbar nor /shared/ov-glyphs.js`);
    }
}

// Nothing draws with Font Awesome's font.
for (const r of CODE_ROOTS) {
    for (const p of walk(path.join(ROOT, r), /\.css$/)) {
        assert.ok(!/font-family:\s*["']?Font ?Awesome/i.test(fs.readFileSync(p, 'utf8')), `${rel(p)} draws with Font Awesome's font`);
    }
    for (const p of walk(path.join(ROOT, r), /\.(html|js|mjs|cjs)$/)) {
        const t = fs.readFileSync(p, 'utf8');
        assert.ok(!/['"]\d+px FontAwesome|Font Awesome 6 Free/.test(t), `${rel(p)} draws with Font Awesome's font`);
        assert.ok(!FA_CSS.test(t), `${rel(p)} links Font Awesome`);
    }
}

// The server-rendered pages get the glyphs from the Shared navbar (shell.page) or from the drop-in.
for (const f of LAYOUTS) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(/shell\.page|ov-glyphs\.js|\/shared\/navbar/.test(t), `${f} renders pages without the navbar or /shared/ov-glyphs.js`);
}

// No Font Awesome markup is left: every icon names an OpenVibe glyph or brand, and the name is one that is drawn.
const files = [];
for (const r of CODE_ROOTS) files.push(...walk(path.join(ROOT, r), /\.(html|js)$/));
const missing = new Map();
for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const fa = t.match(/class=["'][^"']*\bfa-[a-z][^"']*["']/);
    assert.ok(!fa, `${rel(f)} still uses Font Awesome markup: ${fa ? fa[0] : ''}`);
    assert.ok(!/\bfa-(solid|regular|brands|light)\b/.test(t), `${rel(f)} still names a Font Awesome style class`);
    for (const m of t.matchAll(/data-ov-(icon|brand)="([a-z0-9-]+)"/g)) {
        const [kind, name] = [m[1], m[2]];
        const drawn = kind === 'icon' ? glyphs.NAMES.includes(name) : Boolean(brands.BRANDS[name]);
        if (!drawn && !missing.has(`${kind}:${name}`)) missing.set(`${kind}:${name}`, rel(f));
    }
}
assert.deepStrictEqual([...missing].map(([n, f]) => `${n} (${f})`), [], 'every icon this site names is drawn by the OpenVibe glyphs or brands');

console.log(`no font awesome: ${pages.length} pages, ${files.length} files, every icon named is drawn`);
