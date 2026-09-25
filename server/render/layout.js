'use strict';

/**
 * Page shell — every page on the site is server-rendered through this: full <head> SEO
 * (title, description, canonical, robots, Open Graph, Twitter card, JSON-LD), the shared
 * OpenVibe Frame (theme-loader first so there is no flash, navbar.js + footer.js from the
 * Network), this site's small stylesheet and its progressive script.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { escapeHtml } = require('./highlight');

const SITE_NAME = 'OpenVibe.Community';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'The people of OpenVibe — a community-run, open source home for pastes, spaces and threads, and soon submissions. Free speech within the rules.';
const DEFAULT_OG_IMAGE = `${config.baseUrl}/og-default.png`;

// Content-hashed asset URLs so browsers and nginx can cache them for a year and still pick up
// every deploy (the same scheme Live uses in server/web/assets.js).
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const _hashes = new Map();
function assetVersion(rel) {
    if (_hashes.has(rel)) return _hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('md5').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* */ }
    if (config.isProduction) _hashes.set(rel, v);
    return v;
}
function asset(rel) { return `/${rel}?v=${assetVersion(rel)}`; }

const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${config.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);

function jsonLdScript(objects) {
    const list = (Array.isArray(objects) ? objects : [objects]).filter(Boolean);
    if (!list.length) return '';
    // </script> inside a JSON string would end the block early — encode the angle bracket.
    return list.map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`).join('\n');
}

function navbarInit(opts) {
    const cfg = {
        service: 'community',
        apiBase: NETWORK_URL,
        links: [
            { label: 'Pastes', href: '/pastes', active: opts.active === 'pastes' },
            { label: 'Spaces', href: '/s', active: opts.active === 'spaces' },
            { label: 'Pulse', href: '/pulse', active: opts.active === 'pulse' },
            { label: 'Search', href: '/search', icon: 'fa-magnifying-glass', active: opts.active === 'search' },
            { label: 'New paste', href: '/new', icon: 'fa-plus', active: opts.active === 'new' },
        ],
        menu: { after: [{ label: 'My pastes', href: '/my', icon: 'fa-paste' }] },
        history: { type: opts.historyType || 'page', title: opts.historyTitle || opts.title },
        silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: `/auth/login?next=${encodeURIComponent(opts.canonicalPath || '/')}`,
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
    };
    return cfg;
}

function footerInit(opts) {
    return {
        service: 'community',
        variant: opts.footerVariant || 'full',
        mount: '#ov-footer',
        brandName: SITE_NAME,
        updates: '/updates',   // the footer's "shipped X ago" line and Updates link open this site's log
        tagline: 'Community-run and open source. Free speech within the rules — the people of OpenVibe.',
        legalBase: config.liveUrl,
        links: [{
            heading: 'Community',
            items: [
                { name: 'Pastes', url: '/pastes' },
                { name: 'Spaces', url: '/s' },
                { name: 'Pulse', url: '/pulse' },
                { name: 'New paste', url: '/new' },
                { name: 'My pastes', url: '/my' },
                { name: 'What is coming', url: '/#coming' },
                { name: 'Source code', url: 'https://github.com/OpenVibers/OpenVibe.Community' },
            ],
        }],
    };
}

/**
 * @param {object} o
 *   title, description, canonicalPath, robots ('index,follow'), ogType ('website'|'article'),
 *   ogImage, jsonLd (array), body (main HTML), active ('home'|'pastes'|'spaces'|'pulse'|'new'|'my'),
 *   feeds ([{ title, href }] RSS alternates; default: the latest-pastes feed),
 *   historyType ('page'|'paste'), historyTitle, footerVariant ('full'|'compact'), bodyClass,
 *   published/modified (ISO, for article:*), noFrame (error pages during outages)
 */
function renderPage(o) {
    const title = o.title ? `${o.title} · ${SITE_NAME}` : `${SITE_NAME} — the people of OpenVibe`;
    const description = (o.description || DEFAULT_DESCRIPTION).replace(/\s+/g, ' ').trim().slice(0, 300);
    const canonical = abs(o.canonicalPath || '/');
    const robots = o.robots || 'index,follow';
    const ogType = o.ogType || 'website';
    const ogImage = o.ogImage || DEFAULT_OG_IMAGE;
    const nav = navbarInit(o);
    const foot = footerInit(o);

    return `<!DOCTYPE html>
<html lang="en" data-page="${escapeHtml(o.active || 'page')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta name="robots" content="${escapeHtml(robots)}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${escapeHtml(ogType)}">
<meta property="og:title" content="${escapeHtml(o.title || SITE_NAME)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
${o.published ? `<meta property="article:published_time" content="${escapeHtml(o.published)}">` : ''}
${o.modified ? `<meta property="article:modified_time" content="${escapeHtml(o.modified)}">` : ''}
<meta name="twitter:card" content="${o.ogImage ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${escapeHtml(o.title || SITE_NAME)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">
${require('openvibe-shared/app-icon').headTags({ site: 'community', iconBase: '/assets' })}
${(o.feeds || [{ title: `${SITE_NAME} — latest pastes`, href: '/feed.xml' }]).map((f) => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(f.title)}" href="${escapeHtml(f.href)}">`).join('\n')}
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<link rel="stylesheet" href="${asset('css/community.css')}">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
${jsonLdScript(o.jsonLd)}
<script src="${ovServe.url('navbar.js')}" defer></script>
<script src="${ovServe.url('footer.js')}" defer></script>
<script src="${asset('js/community.js')}" defer></script>
</head>
<body class="${escapeHtml(o.bodyClass || '')}">
<div id="navbar-mount"></div>
<main id="main" class="page">
${o.body || ''}
</main>
${require('openvibe-shared/frame').footer({ service: 'community', variant: 'full', updates: '/updates' })}
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer: foot }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeNavbar) OpenVibeNavbar.init(window.__OV_PAGE.navbar); } catch (e) { /* the Frame is optional */ }
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* */ }
});
</script>
</body>
</html>`;
}

module.exports = { renderPage, asset, assetVersion, abs, jsonLdScript, SITE_NAME, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE };
