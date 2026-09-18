'use strict';

/**
 * robots.txt, the dynamic sitemap and the RSS feed of latest pastes. JSON-LD builders live
 * here too so page templates stay about markup.
 */
const config = require('./config');
const catalog = require('./pastes/catalog');
const { escapeHtml } = require('./render/highlight');
const { abs, SITE_NAME, DEFAULT_DESCRIPTION } = require('./render/layout');

const SITEMAP_TTL_MS = 60 * 60 * 1000;

function isoDate(v) {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(String(v)) ? `${String(v).replace(' ', 'T')}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function clean(s, max) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── JSON-LD ──────────────────────────────────────────────────
function websiteLd() {
    return {
        '@context': 'https://schema.org', '@type': 'WebSite',
        name: SITE_NAME, url: `${config.baseUrl}/`, description: DEFAULT_DESCRIPTION,
        potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: `${config.baseUrl}/pastes?q={search_term_string}` }, 'query-input': 'required name=search_term_string' },
        publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' },
    };
}

function breadcrumbLd(items) {
    return {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: clean(it.name, 90), item: abs(it.url) })),
    };
}

function authorLd(paste) {
    const name = paste.display_name || paste.username;
    if (!name) return { '@type': 'Person', name: 'Anonymous' };
    return { '@type': 'Person', name, url: `${config.liveUrl}/@${encodeURIComponent(paste.username || name)}` };
}

function pasteLd(paste, { description, image }) {
    const isScreenshot = paste.type === 'screenshot';
    const url = abs(`/p/${paste.slug}`);
    const base = {
        '@context': 'https://schema.org',
        '@type': isScreenshot ? 'ImageObject' : 'Article',
        headline: clean(paste.title || 'Untitled', 110),
        name: clean(paste.title || 'Untitled', 110),
        description,
        url,
        mainEntityOfPage: url,
        author: authorLd(paste),
        datePublished: isoDate(paste.created_at) || undefined,
        dateModified: isoDate(paste.updated_at || paste.created_at) || undefined,
        publisher: { '@type': 'Organization', name: SITE_NAME, url: `${config.baseUrl}/` },
        interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ViewAction', userInteractionCount: Number(paste.views) || 0 },
    };
    if (isScreenshot) { base.contentUrl = image; base.uploadDate = base.datePublished; }
    else {
        base.image = image;
        base.hasPart = {
            '@type': 'SoftwareSourceCode',
            programmingLanguage: paste.language && paste.language !== 'text' ? paste.language : undefined,
            codeRepository: url,
        };
    }
    return base;
}

// ── robots.txt ───────────────────────────────────────────────
function robotsTxt() {
    return [
        'User-agent: *',
        'Allow: /',
        'Disallow: /api/',
        'Disallow: /auth/',
        'Disallow: /my',
        'Disallow: /new',
        'Disallow: /*?sso=',
        '',
        `Sitemap: ${config.baseUrl}/sitemap.xml`,
        '',
    ].join('\n');
}

// ── sitemap.xml (cached ~1h) ─────────────────────────────────
let _sitemap = null, _sitemapAt = 0;
async function buildSitemap() {
    const urls = [];
    const add = (loc, lastmod, changefreq, priority) => urls.push(
        `  <url><loc>${escapeHtml(abs(loc))}</loc>${lastmod ? `<lastmod>${lastmod.slice(0, 10)}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`
    );
    add('/', null, 'hourly', '1.0');
    add('/pastes', null, 'hourly', '0.8');
    add('/pastes?sort=views', null, 'daily', '0.5');
    for (const p of await catalog.recent()) {
        if (Number(p.is_nsfw) || Number(p.burn_after_read)) continue;
        add(`/p/${p.slug}`, isoDate(p.updated_at || p.created_at), 'weekly', '0.6');
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
async function sitemapHandler(_req, res) {
    if (!_sitemap || Date.now() - _sitemapAt > SITEMAP_TTL_MS) {
        try { _sitemap = await buildSitemap(); _sitemapAt = Date.now(); }
        catch (e) { console.warn('[SEO] sitemap build failed:', e.message); if (!_sitemap) return res.status(503).end(); }
    }
    res.type('application/xml').set('Cache-Control', 'public, max-age=900').send(_sitemap);
}

// ── RSS feed of the latest pastes ────────────────────────────
async function feedHandler(_req, res) {
    const items = (await catalog.latest(30)).filter((p) => !Number(p.is_nsfw)).map((p) => {
        const url = abs(`/p/${p.slug}`);
        const desc = p.type === 'screenshot' ? 'A screenshot shared on OpenVibe.Community.' : clean(p.content || '', 300);
        return `    <item>
      <title>${escapeHtml(p.title || 'Untitled')}</title>
      <link>${escapeHtml(url)}</link>
      <guid isPermaLink="true">${escapeHtml(url)}</guid>
      ${isoDate(p.created_at) ? `<pubDate>${new Date(isoDate(p.created_at)).toUTCString()}</pubDate>` : ''}
      <dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">${escapeHtml(p.display_name || p.username || 'Anonymous')}</dc:creator>
      <description>${escapeHtml(desc)}</description>
    </item>`;
    });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME} — latest pastes</title>
    <link>${escapeHtml(config.baseUrl)}/pastes</link>
    <atom:link href="${escapeHtml(config.baseUrl)}/feed.xml" rel="self" type="application/rss+xml"/>
    <description>${escapeHtml(DEFAULT_DESCRIPTION)}</description>
    <language>en</language>
${items.join('\n')}
  </channel>
</rss>
`;
    res.type('application/rss+xml').set('Cache-Control', 'public, max-age=300').send(xml);
}

function resetCaches() { _sitemap = null; _sitemapAt = 0; }

module.exports = { isoDate, clean, websiteLd, breadcrumbLd, pasteLd, robotsTxt, buildSitemap, sitemapHandler, feedHandler, resetCaches };
