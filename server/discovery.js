'use strict';

/**
 * What Community tells crawlers, feed readers and language models: the robots.txt disallow set,
 * the /llms.txt and /llms-full.txt sections, the sitemap rows (cached ~1h) and the feed items.
 * Only data lives here; openvibe-shared/seo writes every format (server/app.js, server/forum/routes.js).
 */
const config = require('./config');
const catalog = require('./pastes/catalog');
const { abs } = require('./render/layout');
const { isoDate, clean } = require('./render/jsonld');

const SITEMAP_TTL_MS = 60 * 60 * 1000;
const ROBOTS_DISALLOW = ['/api/', '/auth/', '/my', '/new', '/s/*/new', '/*?sso='];
const SUMMARY = 'The discussion side of the OpenVibe network: pastes (text and screenshots), spaces with threads, and the Pulse feed of what is happening across the network.';
const CONTENT_LABELS = 'Pastes made by the OpenVibe AI (moments caught from live streams) carry origin "ai" and are labelled as AI-generated; everything else was written by people.';

// The forum service (server/forum/service.js), when the app has one: threads join the sitemap,
// the feeds and /llms-full.txt.
let _forum = null;
function useForum(forum) { _forum = forum || null; resetCaches(); }

// ── llms.txt / llms-full.txt (llmstxt.org) ───────────────────
function llmsSections() {
    const u = config.baseUrl;
    return [
        { title: 'Browse', links: [
            { title: 'Pastes', url: `${u}/pastes`, note: 'public pastes, newest first (?type=pastes|images|all, ?sort=views, ?lang=<language>)' },
            { title: 'Spaces', url: `${u}/s`, note: 'open discussion spaces and their threads' },
            { title: 'Pulse', url: `${u}/pulse`, note: 'network activity' },
        ] },
        { title: 'Machine-readable', links: [
            { title: 'Sitemap', url: `${u}/sitemap.xml` },
            { title: 'Latest pastes (RSS)', url: `${u}/feed.xml` },
            { title: 'Latest threads (RSS)', url: `${u}/s/feed.xml` },
            { title: 'Full text for language models', url: `${u}/llms-full.txt` },
        ] },
    ];
}

/** The latest public threads and text pastes in full (no NSFW, no burn-after-read, nothing gated). */
async function llmsFullSections() {
    const { markdownToText } = require('./render/markdown');
    const sections = [{ title: 'Content labels', pages: [{ title: 'Who wrote what', url: '/', text: CONTENT_LABELS }] }];
    if (_forum) {
        const threads = await _forum.recentPublic({ limit: 50 });
        sections.push({ title: 'Latest threads', pages: threads.map((t) => ({
            title: `${t.title} (${t.space_name})`, url: abs(`/s/${t.space_slug}/t/${t.slug}`), text: markdownToText(t.opening, 4000),
        })) });
    }
    const pastes = (await catalog.latest(30)).filter((p) => !Number(p.is_nsfw) && !Number(p.burn_after_read) && p.type !== 'screenshot');
    sections.push({ title: 'Latest pastes', pages: pastes.map((p) => ({
        title: p.title || 'Untitled', url: abs(`/p/${p.slug}`), text: String(p.content || '').slice(0, 4000),
    })) });
    return sections;
}

// ── sitemap.xml rows (cached ~1h) ────────────────────────────
let _sitemap = null, _sitemapAt = 0;
async function buildSitemapRows() {
    const rows = [];
    const add = (loc, lastmod, changefreq, priority) => rows.push({ loc: abs(loc), lastmod, changefreq, priority });
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
        for (const s of await _forum.publicSpaces()) add(`/s/${s.slug}`, s.last_activity_at || null, 'hourly', '0.7');
        for (const t of await _forum.recentPublic({ limit: 1000 })) add(`/s/${t.space_slug}/t/${t.slug}`, isoDate(t.last_activity_at || t.created_at), 'daily', '0.6');
    }
    return rows;
}
/** The sitemap rows, rebuilt at most hourly; a failed rebuild keeps serving the last good rows. */
async function sitemapRows() {
    if (!_sitemap || Date.now() - _sitemapAt > SITEMAP_TTL_MS) {
        try { _sitemap = await buildSitemapRows(); _sitemapAt = Date.now(); }
        catch (e) { console.warn('[SEO] sitemap build failed:', e.message); if (!_sitemap) throw e; }
    }
    return _sitemap;
}

// ── Feed items (openvibe-shared/seo feedXml, 2.5.0 item shape) ──
/** The latest pastes for /feed.xml. */
async function pasteFeedItems() {
    return (await catalog.latest(30)).filter((p) => !Number(p.is_nsfw)).map((p) => {
        const url = abs(`/p/${p.slug}`);
        const description = p.type === 'screenshot' ? 'A screenshot shared on OpenVibe.Community.' : clean(p.content || '', 300);
        return { title: p.title || 'Untitled', link: url, guid: url, description, content: description,
            author: p.display_name || p.username || 'Anonymous', published: isoDate(p.created_at), updated: isoDate(p.updated_at || p.created_at) };
    });
}

/** Threads (forum.recentPublic rows) for /s/feed.xml and /s/:space/feed.xml. */
function threadFeedItems(threads) {
    const { markdownToText } = require('./render/markdown');
    return threads.map((t) => {
        const url = abs(`/s/${t.space_slug}/t/${t.slug}`);
        const description = markdownToText(t.opening, 300);
        return { title: t.title, link: url, guid: url, description, content: description,
            author: undefined, published: isoDate(t.created_at), updated: isoDate(t.last_activity_at || t.created_at) };
    });
}

function resetCaches() { _sitemap = null; _sitemapAt = 0; }

module.exports = { ROBOTS_DISALLOW, SUMMARY, CONTENT_LABELS, llmsSections, llmsFullSections, sitemapRows, pasteFeedItems, threadFeedItems, useForum, resetCaches };
