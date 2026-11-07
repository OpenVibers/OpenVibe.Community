'use strict';

/**
 * What Community tells crawlers, feed readers and language models: the robots.txt disallow set,
 * the /llms.txt and /llms-full.txt sections, the sitemap rows (cached ~1h) and the feed items.
 * Only data lives here; openvibe-shared/seo writes every format (server/app.js, server/forum/routes.js).
 */
const config = require('./config');
const catalog = require('./pastes/catalog');
const source = require('./pastes/source');
const { abs } = require('./render/layout');
const { spacePath, threadPath } = require('./forum/paths');
const { isoDate, clean } = require('./render/jsonld');

const SITEMAP_TTL_MS = 60 * 60 * 1000;
const ROBOTS_DISALLOW = ['/api/', '/auth/', '/my', '/new', '/forum/*/new', '/*?sso='];
const SUMMARY = 'The discussion side of the OpenVibe network: pastes (text and screenshots), forums with threads, and the Pulse feed of what is happening across the network.';
const CONTENT_LABELS = 'Pastes made by the OpenVibe AI (moments caught from live streams) carry origin "ai" and are labelled as AI-generated; everything else was written by people.';

// The forum service (server/forum/service.js), when the app has one: threads join the sitemap,
// the feeds and /llms-full.txt.
let _forum = null;
function useForum(forum) { _forum = forum || null; resetCaches(); }

// ── llms.txt / llms-full.txt (llmstxt.org) ───────────────────
function llmsSections() {
    const u = config.baseUrl;
    return {
        sections: [
            { title: 'Browse', links: [
                { title: 'OpenVibe.Community', url: `${u}/`, note: 'pastes, forum and network activity' },
                { title: 'Pastes', url: `${u}/pastes`, note: 'public pastes, newest first (?type=pastes|images|all, ?sort=views, ?lang=<language>)' },
                { title: 'Forum', url: `${u}/forum`, note: 'open discussion forums and their threads', html: true },
                { title: 'Pulse', url: `${u}/pulse`, note: 'network activity', html: true },
            ] },
            // The API is a primary entry for an agent, not something to skip.
            { title: 'API', links: [{ title: 'OpenAPI 3.1 document', url: `${u}/openapi.json`, note: 'every /api route, with its fields' }] },
            // Sharing (design 2026-11-06): one audience and a transfer, from the page or from an agent.
            { title: 'Sharing a paste', links: [
                { title: 'Who can open a paste', url: `${u}/docs/sharing`, note: 'Everyone, anyone with the link, specific people (@names), only me; transfer ownership to a person' },
                { title: 'Share one paste with a bearer token', url: `${u}/api/v1/paste/{slug}/share`,
                    note: `PUT with {"audience":"people","members":[{"name":"@maticus","role":"viewer"}]}; curl -X PUT -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' ${u}/api/v1/paste/<slug>/share -d '{"audience":"people","members":[{"name":"@maticus"}]}'` },
                { title: 'Make a paste only two people can open, and offer it, in one call', url: `${u}/api/pastes`,
                    note: `curl -X POST -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' ${u}/api/pastes -d '{"content":"the notes","audience":"people","members":["@maticus"],"transfer_to":"@maticus","keep_access":false}'` },
                { title: 'Accept, decline or cancel a transfer', url: `${u}/api/v1/paste/{slug}/share/transfer/{accept,decline,cancel}`,
                    note: `POST {"transfer_id":"<uuid>"} as the recipient (accept/decline) or the owner (cancel)` },
            ] },
            // Locked pastes (Locker design 2026-11-06): sealed in the browser, never readable by us.
            { title: 'Locked pastes', links: [
                { title: 'Locked pastes on OpenVibe Community', url: `${u}/docs/locked-pastes`,
                    note: 'people, password and link locks; the envelope format; the agent path with openvibe-sdk/locker' },
            ] },
        ],
        optional: [
            { title: 'Sitemap', url: `${u}/sitemap.xml` },
            { title: 'Latest pastes (RSS)', url: `${u}/feed.xml` },
            { title: 'Latest threads (RSS)', url: `${u}/forum/feed.xml` },
            { title: 'Full text for language models', url: `${u}/llms-full.txt` },
        ],
    };
}

/** The latest public threads and text pastes in full (no NSFW, no burn-after-read, nothing gated). */
async function llmsFullSections() {
    const { markdownToText } = require('./render/markdown');
    const sections = [
        { title: 'Content labels', pages: [{ title: 'Who wrote what', url: '/', text: CONTENT_LABELS }] },
    ];
    if (_forum) {
        const threads = await _forum.recentPublic({ limit: 50 });
        sections.push({ title: 'Latest threads', pages: threads.map((t) => ({
            title: `${t.title} (${t.space_name})`, url: abs(threadPath(t.space_slug, t.slug)), text: markdownToText(t.opening, Infinity),
        })) });
    }
    const pastes = (await catalog.latest(30)).filter((p) => !Number(p.is_nsfw) && !Number(p.burn_after_read) && p.type !== 'screenshot');
    const full = await Promise.all(pastes.map((p) => source.publicForDiscovery(p.slug)));
    sections.push({ title: 'Latest pastes', pages: full.filter(Boolean).map((p) => ({
        title: p.title || 'Untitled', url: abs(`/p/${require('./pastes/url').canonicalSlug(p)}`), text: String(p.content || ''),
    })) });
    // Sharing (design 2026-11-06): the four audiences, the transfer, and the curls an agent uses.
    sections.push({ title: 'Sharing a paste', pages: [{ title: 'Sharing a paste', url: '/docs/sharing',
        text: require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'sharing.md'), 'utf8') }] });
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
    // No /p/:slug rows: a paste is link-shared content and is noindex (SEO-29), so it must not be
    // in a sitemap. The /pastes browse and search pages above are the surfaces meant for search.
    if (_forum) {
        add('/forum', null, 'hourly', '0.8');
        add('/pulse', null, 'hourly', '0.5');
        for (const s of await _forum.publicSpaces()) add(spacePath(s.slug), s.last_activity_at || null, 'hourly', '0.7');
        for (const t of await _forum.recentPublic({ limit: 1000 })) add(threadPath(t.space_slug, t.slug), isoDate(t.last_activity_at || t.created_at), 'daily', '0.6');
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
        const url = abs(`/p/${require('./pastes/url').canonicalSlug(p)}`);
        const description = p.type === 'screenshot' ? 'A screenshot shared on OpenVibe.Community.' : clean(p.content || '', 300);
        return { title: p.title || 'Untitled', link: url, guid: url, description, content: description,
            author: p.display_name || p.username || 'Anonymous', published: isoDate(p.created_at), updated: isoDate(p.updated_at || p.created_at) };
    });
}

/** Threads (forum.recentPublic rows) for /forum/feed.xml and /forum/:space/feed.xml. */
function threadFeedItems(threads) {
    const { markdownToText } = require('./render/markdown');
    return threads.map((t) => {
        const url = abs(threadPath(t.space_slug, t.slug));
        const description = markdownToText(t.opening, 300);
        return { title: t.title, link: url, guid: url, description, content: description,
            author: undefined, published: isoDate(t.created_at), updated: isoDate(t.last_activity_at || t.created_at) };
    });
}

/** A thread's newest posts for /forum/:space/:slug/feed.xml (opening post and replies). */
function postFeedItems(space, thread, posts) {
    const { markdownToText } = require('./render/markdown');
    return posts.map((p) => {
        const url = abs(`${threadPath(space.slug, thread.slug)}#post-${p.id}`);
        const description = markdownToText(p.body_markdown || '', 300);
        return { title: p.is_opening ? thread.title : `Re: ${thread.title}`, link: url, guid: url, description, content: description,
            author: undefined, published: isoDate(p.created_at), updated: isoDate(p.updated_at || p.created_at) };
    });
}

function resetCaches() { _sitemap = null; _sitemapAt = 0; }

module.exports = { ROBOTS_DISALLOW, SUMMARY, CONTENT_LABELS, llmsSections, llmsFullSections, sitemapRows, pasteFeedItems, threadFeedItems, postFeedItems, useForum, resetCaches };
