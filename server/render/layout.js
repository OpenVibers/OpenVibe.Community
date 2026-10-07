'use strict';

/**
 * Page shell — every page on the site is server-rendered through openvibe-shared/shell: full <head>
 * SEO (description, canonical, robots, Open Graph, Twitter card, JSON-LD and the ai-summary page
 * summary), the shared OpenVibe Frame (theme-loader first so there is no flash, navbar.js +
 * footer.js from the Network, the SSR footer), plus this site's small stylesheet and its
 * progressive script.
 */
const crypto = require('crypto');
const ovServe = require('openvibe-shared/serve');
const shell = require('openvibe-shared/shell');
const appIcon = require('openvibe-shared/app-icon');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { escapeHtml } = require('./highlight');

const SITE_NAME = 'OpenVibe.Community';
const NETWORK_URL = 'https://openvibe.network';
const DEFAULT_DESCRIPTION = 'The people of OpenVibe — a community-run, open source home for pastes, comments, Pulse and submissions. Free speech within the rules.';
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

// The deployed release (app.js sets it from openvibe-shared/release): openvibe-shared/boost swaps a page in place only
// between pages of the same release, and does a normal load across a deploy.
let RELEASE = 'dev';
function setRelease(id) { if (id) RELEASE = String(id); }

const abs = (p) => (/^https?:\/\//i.test(p) ? p : `${config.baseUrl}${p.startsWith('/') ? '' : '/'}${p}`);

// openvibe-shared/seo cuts descriptions at 160 characters on a word; a longer one loses whole
// trailing sentences here first, so a cut never leaves half a phrase ("… Free…").
const DESCRIPTION_MAX = 160;
function fitDescription(text) {
    if (text.length <= DESCRIPTION_MAX) return text;
    let out = '';
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        const next = out ? `${out} ${sentence}` : sentence;
        if (next.length > DESCRIPTION_MAX) break;
        out = next;
    }
    return out || text;
}

function navbarInit(opts) {
    const cfg = {
        service: 'community',
        apiBase: NETWORK_URL,
        links: [
            { label: 'Pastes', href: '/pastes', active: opts.active === 'pastes' },
            { label: 'Spaces', href: 'https://openvibe.space', active: opts.active === 'spaces' },
            { label: 'Pulse', href: '/pulse', active: opts.active === 'pulse' },
            { label: 'Search', href: '/search', icon: 'fa-magnifying-glass', active: opts.active === 'search' },
            { label: 'New paste', href: '/new', icon: 'fa-plus', active: opts.active === 'new' },
        ],
        menu: { after: [{ label: 'My pastes', href: '/my', icon: 'fa-paste' }] },
        history: { type: opts.historyType || 'page', title: opts.historyTitle || opts.title },
        silentLogin: `${config.baseUrl}/auth/login?silent=1&next={url}`,
        sessionUrl: '/auth/me',
        loginUrl: '/auth/login?next={path}',           // filled from the current page (boost moves between pages)
        logoutUrl: '/auth/logout?next={path}',   // Sign out in the shared navbar ends this site's session too
        notificationsRealtime: true,             // the bell hears new notifications over OpenVibe.Events (Shared 1.22.0)
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
                { name: 'Spaces', url: 'https://openvibe.space' },
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
 *   ogImage, imageAlt, jsonLd (array), alternates ([{ hreflang, href }]), body (main HTML), active ('home'|'pastes'|'spaces'|'pulse'|'new'|'my'),
 *   feeds ([{ title, href }] RSS alternates; default: the latest-pastes feed),
 *   historyType ('page'|'paste'), historyTitle, footerVariant ('full'|'compact'), bodyClass,
 *   styles (Shared stylesheets by name, linked before community.css so this site's rules win: ['showcase.css']),
 *   published/modified (ISO, for article:*), noFrame (error pages during outages)
 */
function renderPage(o) {
    const description = fitDescription((o.description || DEFAULT_DESCRIPTION).replace(/\s+/g, ' ').trim().slice(0, 300));
    const canonical = abs(o.canonicalPath || '/');
    const nav = navbarInit(o);
    const foot = footerInit(o);
    const feeds = o.feeds || [{ title: `${SITE_NAME} — latest pastes`, href: '/feed.xml' }];

    // shell.page writes the document, the SEO head and ai-summary, the theme-loader, navbar.js/footer.js
    // with the navbar init, the noscript nav and the SSR footer; the rest of the head is this site's own.
    const html = shell.page({
        name: SITE_NAME, service: 'community', lang: 'en',
        title: o.title || `${SITE_NAME} — the people of OpenVibe`,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : undefined,
        siteName: SITE_NAME, description, canonical, robots: o.robots || 'index,follow',
        type: o.ogType || 'website', image: o.ogImage || DEFAULT_OG_IMAGE, imageAlt: o.imageAlt,
        jsonLd: o.jsonLd, alternates: o.alternates,
        summary: description, url: canonical, updated: o.modified,
        navbar: nav, home: '/', navLinks: nav.links.map(({ label, href }) => ({ label, href })),
        footer: { service: 'community', variant: 'full', updates: '/updates' },
        head: [
            o.published ? `<meta property="article:published_time" content="${escapeHtml(o.published)}">` : '',
            o.modified ? `<meta property="article:modified_time" content="${escapeHtml(o.modified)}">` : '',
            appIcon.headTags({ site: 'community', iconBase: '/assets' }),
            ...feeds.map((f) => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(f.title)}" href="${escapeHtml(f.href)}">`),
            ...(o.styles || []).map((name) => `<link rel="stylesheet" href="${ovServe.url(name)}">`),
            `<link rel="stylesheet" href="${asset('css/community.css')}">`,
            '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">',
            `<script src="${asset('js/community.js')}" defer></script>`,
            `<meta name="ov-boost" content="community@${escapeHtml(RELEASE)}">`,
            `<script src="${ovServe.url('boost.js')}" data-main="#main" defer></script>`,
        ].filter(Boolean).join('\n'),
        bodyClass: o.bodyClass,
        bodyAttributes: { 'data-page': o.active || 'page' },
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
${o.body || ''}
</main>
<script>
window.__OV_PAGE = ${JSON.stringify({ navbar: nav, footer: foot }).replace(/</g, '\\u003c')};
document.addEventListener('DOMContentLoaded', function () {
  try { if (window.OpenVibeFooter) OpenVibeFooter.init(window.__OV_PAGE.footer); } catch (e) { /* the SSR footer stays */ }
});
</script>`,
    });
    // The default share image is a small card: only a page's own image gets the large Twitter card.
    return o.ogImage ? html : html.replace('<meta name="twitter:card" content="summary_large_image">', '<meta name="twitter:card" content="summary">');
}

module.exports = { renderPage, asset, assetVersion, abs, setRelease, SITE_NAME, DEFAULT_DESCRIPTION, DEFAULT_OG_IMAGE };
