'use strict';

/**
 * The forum's addresses. The forum moved from /s (spaces were its old name) to /forum, and a thread's
 * /t/ segment went with it (design 2026-11-07): /forum, /forum/<space>, /forum/<space>/<thread>.
 * A thread's slug therefore shares a namespace with the space's own sub-routes, so those words are
 * reserved and never become a slug (store.js appends -2 when a title would make one).
 */

const RESERVED_SPACE_SLUGS = new Set(['new', 'discuss', 'feed.xml', 'search', 'about']);
const RESERVED_THREAD_SLUGS = new Set(['new', 'log', 'settings', 'feed.xml', 'moderators', 'chat-room', 'members', 'about', 'search', 'rules', 'wiki', 'edit', 'discuss']);

const spacePath = (slug) => `/forum/${encodeURIComponent(slug)}`;
const threadPath = (spaceSlug, threadSlug) => `/forum/${encodeURIComponent(spaceSlug)}/${encodeURIComponent(threadSlug)}`;

/**
 * An old /s… path (the remainder express gives a router mounted at /s, query included) → its /forum path.
 * /s/general/t/a-title becomes /forum/general/a-title; everything else keeps its shape.
 */
function legacyForumPath(url) {
    const qi = url.indexOf('?');
    const path = qi === -1 ? url : url.slice(0, qi);
    const query = qi === -1 ? '' : url.slice(qi);
    let rest = path === '/' ? '' : path.replace(/\/+$/, '');
    if (rest === '/new-space') return `/forum/new${query}`;
    rest = rest.replace(/^\/([^/]+)\/t(?=\/|$)/, '/$1');
    return `/forum${rest}${query}`;
}

module.exports = { RESERVED_SPACE_SLUGS, RESERVED_THREAD_SLUGS, spacePath, threadPath, legacyForumPath };
