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
    },
};
