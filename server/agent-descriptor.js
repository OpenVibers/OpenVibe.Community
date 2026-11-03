'use strict';
// What openvibe.community tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public home, paste browse and paste pages (with
// their comment threads), the native paste API under /api/pastes and the typed API under /api/v1, their
// OpenAPI document, llms.txt/llms-full.txt and the sitemap.
module.exports = {
    id: 'community',
    name: 'OpenVibe.Community',
    purpose: 'The community hub of the OpenVibe network: pastes, forum spaces and threads, comment threads, Pulse and public submissions.',
    home: 'https://openvibe.community',
    site: 'openvibe.community',
    api: '/api',
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC', 'bearer'],
        rateLimit: 'The public pages are not limited by the app; /api is limited to 120 requests a minute per address and sign-in attempts to 60 per 15 minutes',
        // What a paste's address is, and that it never changes meaning (AGT-4): server/pastes/store.js gives a slug to one
        // paste only, ever: a deleted paste keeps it (soft delete), and an erased one's is retired (migration 0014).
        stableIds: [
            { kind: 'paste', url: 'https://openvibe.community/p/{slug}', id: 'a generated slug (adjective-noun-number for a public paste, longer and secret for an unlisted or private one): given to one paste only, never again, even after it is deleted or its author\'s account is erased', gone: 'a deleted, erased or missing paste answers 404, never another paste' },
        ],
    },
};
