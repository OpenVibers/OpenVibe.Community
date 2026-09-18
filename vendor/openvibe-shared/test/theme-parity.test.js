'use strict';
// The theme catalog and the browser loader's copy of it must agree, every theme must define a
// complete token set once defaults are merged, and the default is the blue Vibe.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { BUILTIN_THEMES, DEFAULT_THEME, DEFAULT_VARS } = require('../builtin-themes');
const { CSS_VARIABLES } = (() => { try { return require('../theme-sync'); } catch { return { CSS_VARIABLES: null }; } })();

// 1. Loader copy is generated from the catalog and not stale.
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-theme-loader.js'), '--check'], { stdio: 'pipe' });

// 2. Default and the three themes this round is about.
assert.strictEqual(DEFAULT_THEME.id, 'vibe');
const by = Object.fromEntries(BUILTIN_THEMES.map((t) => [t.id, t]));
assert.ok(by['violet-hour'], 'the original violet look is kept as Violet Hour');
assert.strictEqual(by['violet-hour'].variables['--accent'], '#8b5cf6');
assert.notStrictEqual(by.vibe.variables['--accent'], by.arctic.variables['--accent'], 'Vibe and Arctic are different blues');
assert.notStrictEqual(by.vibe.variables['--bg-primary'], by.arctic.variables['--bg-primary']);

// 3. Slugs unique, every theme complete after defaults.
const REQUIRED = CSS_VARIABLES || Object.keys(DEFAULT_VARS);
const seen = new Set();
for (const t of BUILTIN_THEMES) {
    assert.ok(!seen.has(t.id), `duplicate theme id ${t.id}`);
    seen.add(t.id);
    const merged = { ...DEFAULT_VARS, ...t.variables };
    for (const k of REQUIRED) assert.ok(merged[k], `${t.id} is missing ${k}`);
    for (const [k, v] of Object.entries(t.variables)) {
        assert.ok(k.startsWith('--'), `${t.id}: ${k} is not a CSS variable`);
        assert.ok(!/url\(|expression|javascript:|var\(/i.test(String(v)), `${t.id}: ${k} has a dangerous value`);
    }
}

// 4. Loader: full sets and stale-token clearing are present.
const loader = require('fs').readFileSync(path.join(__dirname, '..', 'theme-loader.js'), 'utf8');
assert.ok(loader.includes("'violet-hour': {"), 'loader knows Violet Hour');
assert.ok(/'arctic': \{[^\n]*'--success'/.test(loader), 'loader entries carry the full token set');
assert.ok(loader.includes('KNOWN_PROPS'), 'loader clears tokens the new theme does not set');

// 5. Derived tokens: text on the accent always reads, on every theme.
const { contrast, hexToRgb } = require('../builtin-themes');
for (const t of BUILTIN_THEMES) {
    const v = t.variables;
    assert.ok(v['--on-accent'] && v['--accent-rgb'] && v['--accent-glow'] && v['--color-scheme'], `${t.id} lacks derived tokens`);
    assert.ok(contrast(hexToRgb(v['--on-accent']), hexToRgb(v['--accent'])) >= 3, `${t.id}: --on-accent does not read on --accent`);
    assert.strictEqual(v['--color-scheme'], t.mode === 'light' ? 'light' : 'dark');
}
console.log('theme parity: all checks passed');
