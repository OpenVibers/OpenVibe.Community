'use strict';

/**
 * JSON-LD builders for the pages (WebSite, breadcrumbs, pastes and their authors) and the
 * two small text helpers they share with the templates. renderPage emits them through
 * openvibe-shared/seo's jsonLdTag (via headTags).
 */
const config = require('../config');
const { abs, SITE_NAME, DEFAULT_DESCRIPTION } = require('./layout');

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

module.exports = { isoDate, clean, websiteLd, breadcrumbLd, pasteLd };
