'use strict';
/**
 * Every route Express knows after boot, read from the router stack (app._router.stack, recursing
 * into mounted routers), so a route added later is crawled by the security tests without anyone
 * listing it. → [{ method: 'GET', path: '/api/pastes/:slug' }, …] (array paths expanded, RegExp
 * routes skipped).
 */

/** A mounted router's path from its layer regexp (express 4: ^\/api\/pastes\/?(?=\/|$) with keys). */
function mountPath(layer) {
    if (!layer.regexp || layer.regexp.fast_slash) return '';
    let src = layer.regexp.source.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '');
    let i = 0;
    src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${(layer.keys[i++] || { name: `p${i}` }).name}`);
    return src.replace(/\\(.)/g, '$1');
}

function listRoutes(app) {
    const out = [];
    const seen = new Set();
    const add = (method, path) => {
        const p = (path.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')) || '/';
        const key = `${method} ${p}`;
        if (!seen.has(key)) { seen.add(key); out.push({ method, path: p }); }
    };
    (function walk(stack, prefix) {
        for (const layer of stack) {
            if (layer.route) {
                const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
                for (const p of paths) {
                    if (typeof p !== 'string') continue;
                    for (const m of Object.keys(layer.route.methods)) if (m !== '_all') add(m.toUpperCase(), prefix + p);
                    if (layer.route.methods._all) add('ALL', prefix + p);
                }
            } else if (layer.handle && Array.isArray(layer.handle.stack)) {
                walk(layer.handle.stack, prefix + mountPath(layer));
            }
        }
    })(app._router.stack, '');
    return out;
}

/** Fill :params from `values` (name → value or [values]); every combination, capped. */
function fill(path, values, cap = 12) {
    const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    let paths = [path];
    for (const n of names) {
        const vs = [].concat(values[n] !== undefined ? values[n] : values['*']);
        const next = [];
        for (const p of paths) for (const v of vs) next.push(p.replace(`:${n}`, encodeURIComponent(String(v))));
        paths = next.slice(0, cap);
    }
    return paths;
}

module.exports = { listRoutes, fill, mountPath };
