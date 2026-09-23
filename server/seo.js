'use strict';

/**
 * robots.txt, the dynamic sitemap and the RSS feeds (latest pastes; latest threads overall and
 * per space). JSON-LD builders live here too so page templates stay about markup.
 */
const config = require('./config');
const catalog = require('./pastes/catalog');
const { escapeHtml } = require('./render/highlight');
const { abs, SITE_NAME, DEFAULT_DESCRIPTION } = require('./render/layout');

const SITEMAP_TTL_MS = 60 * 60 * 1000;

// The forum service (server/forum/service.js), when the app has one: threads join the sitemap
// and get their own feeds.
let _forum = null;
function useForum(forum) { _forum = forum || null; _sitemap = null; }

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

/** Who wrote a thread or post, for JSON-LD: a person, the AI label (never a person), or anonymous. */
function discussionAuthorLd(a) {
    if (!a) return { '@type': 'Person', name: 'Anonymous' };
    if (a.is_ai) return { '@type': 'Organization', name: a.display_name || 'OpenVibe AI' };
    const name = a.display_name || a.username || 'Anonymous';
    return a.username ? { '@type': 'Person', name, url: `${config.liveUrl}/@${encodeURIComponent(a.username)}` } : { '@type': 'Person', name };
}

/** DiscussionForumPosting for a thread page: the opening post, counters and the replies on the page. */
function threadLd({ space, thread, posts, opening, description }) {
    const { markdownToText } = require('./render/markdown');
    const url = abs(`/s/${space.slug}/t/${thread.slug}`);
    const replies = posts.filter((p) => !p.is_opening && !p.deleted).slice(0, 20);
    return {
        '@context': 'https://schema.org',
        '@type': 'DiscussionForumPosting',
        headline: clean(thread.title, 110),
        text: opening && !opening.deleted ? markdownToText(opening.body_markdown, 5000) : description,
        url,
        mainEntityOfPage: url,
        author: discussionAuthorLd(thread.author),
        datePublished: isoDate(thread.created_at) || undefined,
        dateModified: isoDate((opening && opening.updated_at) || thread.created_at) || undefined,
        isPartOf: { '@type': 'CollectionPage', name: space.name, url: abs(`/s/${space.slug}`) },
        commentCount: thread.reply_count,
        interactionStatistic: [
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: thread.reply_count },
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: Math.max(Number(thread.score) || 0, 0) },
        ],
        comment: replies.map((p) => ({
            '@type': 'Comment',
            text: markdownToText(p.body_markdown, 2000),
            author: discussionAuthorLd(p.author),
            datePublished: isoDate(p.created_at) || undefined,
            url: `${url}#post-${p.id}`,
        })),
    };
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
        'Disallow: /s/*/new',
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
    if (_forum) {
        add('/s', null, 'hourly', '0.8');
        add('/pulse', null, 'hourly', '0.5');
        for (const s of _forum.publicSpaces()) add(`/s/${s.slug}`, s.last_activity_at || null, 'hourly', '0.7');
        for (const t of _forum.recentPublic({ limit: 1000 })) add(`/s/${t.space_slug}/t/${t.slug}`, isoDate(t.last_activity_at || t.created_at), 'daily', '0.6');
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

// ── RSS feeds of the latest threads (/s/feed.xml, /s/:space/feed.xml) ──
function threadFeed({ space = null, threads }) {
    const { markdownToText } = require('./render/markdown');
    const items = threads.map((t) => {
        const url = abs(`/s/${t.space_slug}/t/${t.slug}`);
        return `    <item>
      <title>${escapeHtml(t.title)}</title>
      <link>${escapeHtml(url)}</link>
      <guid isPermaLink="true">${escapeHtml(url)}</guid>
      ${isoDate(t.created_at) ? `<pubDate>${new Date(isoDate(t.created_at)).toUTCString()}</pubDate>` : ''}
      <category>${escapeHtml(t.space_name)}</category>
      <description>${escapeHtml(markdownToText(t.opening, 300))}</description>
    </item>`;
    });
    const link = abs(space ? `/s/${space.slug}` : '/s');
    const self = abs(space ? `/s/${space.slug}/feed.xml` : '/s/feed.xml');
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(space ? `${SITE_NAME} — ${space.name}` : `${SITE_NAME} — latest threads`)}</title>
    <link>${escapeHtml(link)}</link>
    <atom:link href="${escapeHtml(self)}" rel="self" type="application/rss+xml"/>
    <description>${escapeHtml(space ? (space.description || space.name) : 'New threads in the public spaces of OpenVibe.Community.')}</description>
    <language>en</language>
${items.join('\n')}
  </channel>
</rss>
`;
}

function resetCaches() { _sitemap = null; _sitemapAt = 0; }

module.exports = { isoDate, clean, websiteLd, breadcrumbLd, pasteLd, threadLd, discussionAuthorLd, robotsTxt, buildSitemap, sitemapHandler, feedHandler, threadFeed, useForum, resetCaches };
