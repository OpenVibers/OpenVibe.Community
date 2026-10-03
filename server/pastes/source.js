'use strict';

/**
 * Where server-rendered pages read pastes from: Community's own store, through the same service
 * the API uses, so a page and the API can never disagree about visibility or view counts.
 *
 * app.js installs the service once at boot (source.use(service)); the call shapes
 * (listPastes / getPaste / listByUser / createPaste) are stable, and `ctx` carries the visitor
 * ({ token, ip, userAgent, viewer, noView }).
 */
const { ANONYMOUS } = require('../identity/viewer');

let current = null;

function localSource(service) {
    const who = (ctx) => (ctx && ctx.viewer) || ANONYMOUS;
    return {
        local: true,
        service,
        listPastes: (query, ctx = {}) => service.list(who(ctx), query || {}),
        getPaste: async (slug, ctx = {}) => (await service.get(who(ctx), slug, { noView: !!ctx.noView, ip: ctx.ip, userAgent: ctx.userAgent })).paste,
        publicForDiscovery: (slug) => service.publicForDiscovery(slug),
        listByUser: (username, query, ctx = {}) => service.byUser(who(ctx), username, query || {}),
        createPaste: (body, ctx = {}) => service.createText(who(ctx), body || {}),
    };
}

/** Install the store (the only paste authority). */
function use(service) {
    current = localSource(service);
    return current;
}

module.exports = {
    use,
    get local() { return !!(current && current.local); },
    listPastes: (...a) => current.listPastes(...a),
    getPaste: (...a) => current.getPaste(...a),
    publicForDiscovery: (...a) => current.publicForDiscovery(...a),
    listByUser: (...a) => current.listByUser(...a),
    createPaste: (...a) => current.createPaste(...a),
};
