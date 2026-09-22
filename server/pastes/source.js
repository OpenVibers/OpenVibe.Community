'use strict';

/**
 * Where server-rendered pages read pastes from.
 *
 *   'live' authority      → live-client.js (OpenVibe.Live's API, Media behind it) — the default.
 *   'community' authority → this site's own store, through the same service the API uses, so a
 *                           page and the API can never disagree about visibility or view counts.
 *
 * Both expose the live-client call shapes (listPastes / getPaste / listByUser / createPaste);
 * `ctx` carries the visitor ({ token, ip, userAgent, viewer, noView }).
 */
const live = require('../live-client');
const { ANONYMOUS } = require('../identity/viewer');

let current = { local: false, listPastes: live.listPastes, getPaste: live.getPaste, listByUser: live.listByUser, createPaste: live.createPaste };

function localSource(service) {
    const who = (ctx) => (ctx && ctx.viewer) || ANONYMOUS;
    return {
        local: true,
        service,
        listPastes: (query, ctx = {}) => service.list(who(ctx), query || {}),
        getPaste: async (slug, ctx = {}) => (await service.get(who(ctx), slug, { noView: !!ctx.noView, ip: ctx.ip, userAgent: ctx.userAgent })).paste,
        listByUser: (username, query, ctx = {}) => service.byUser(who(ctx), username, query || {}),
        createPaste: (body, ctx = {}) => service.createText(who(ctx), body || {}),
    };
}

/** Switch to the store (community authority); passing nothing goes back to Live. */
function use(service) {
    current = service ? localSource(service) : { local: false, listPastes: live.listPastes, getPaste: live.getPaste, listByUser: live.listByUser, createPaste: live.createPaste };
    return current;
}

module.exports = {
    use,
    get local() { return current.local; },
    listPastes: (...a) => current.listPastes(...a),
    getPaste: (...a) => current.getPaste(...a),
    listByUser: (...a) => current.listByUser(...a),
    createPaste: (...a) => current.createPaste(...a),
};
