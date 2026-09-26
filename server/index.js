'use strict';

/**
 * OpenVibe.Community — process entry. `node server/index.js`
 * Listens on PORT (4200) behind nginx; see deploy/ for the unit and vhost.
 */
const config = require('./config');
const { createApp } = require('./app');

const app = createApp();
// Community → OpenVibe.Events (server/events.js): off unless EVENTS_URL and the client secret are set.
try { require('./events').init(require('./db').getDb()); } catch (err) { console.warn('[Events] not started:', err.message); }
// The Roadmap space follows docs/roadmap/public.json (server/forum/roadmap.js).
try {
    const r = require('./forum/roadmap').syncFromFile(require('./db').getDb());
    if (r && (r.created || r.updated)) console.log(`[Roadmap] ${r.created} item(s) added, ${r.updated} updated`);
} catch (err) { console.warn('[Roadmap] not synced:', err.message); }
const server = app.listen(config.port, config.host, () => {
    console.log(`[Community] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
    console.log(config.pastesAuthority === 'community'
        ? `[Community] pastes: this site is the authority (${config.dbPath}), identity via ${config.networkUrl}`
        : `[Community] pastes via ${config.liveInternalUrl}/api/pastes, identity via ${config.networkUrl}`);
});
server.keepAliveTimeout = 65_000;
// Subscribe Pulse to public activity at Events (idempotent; off without EVENTS_URL / COMMUNITY_EVENTS_SECRET).
let subscriptions = null;
try {
    const secret = String(process.env.COMMUNITY_EVENTS_SECRET || '').split(',')[0].trim();
    subscriptions = require('./pulse/consumer').startSubscriptions({ config, port: config.port, secret });
} catch (err) { console.warn('[Pulse consumer] not subscribed:', err.message); }
// community.profile on Network (Contracts 0.41.0): a 5-minute scan of changed authors (off without the client secret).
let profiles = null;
try { profiles = require('./identity/profile-module').createProfileModule({ db: require('./db').getDb(), config }); profiles.start(); } catch (err) { console.warn('[Modules] community.profile not started:', err.message); }
// Public threads and pastes in OpenVibe.Search (WS-O task 10): community.index_document.* through the outbox (off without EVENTS_URL).
let searchDocs = null;
try { searchDocs = require('./search/documents').createSearchDocuments({ db: require('./db').getDb() }); searchDocs.start(); } catch (err) { console.warn('[Search] documents not started:', err.message); }

// ── Stop (roadmap WS-P lifecycle; server/graceful.js) ────────
// SIGTERM: the Pulse subscription retries, the community.profile scan and the search-document scans
// stop (nothing new starts); the server stops taking connections, closes idle keep-alive ones (it keeps
// them 65 s otherwise) and lets requests in flight finish (4 s at most); then the profile scan in
// progress, the Discord relay's drain and the events outbox's send finish (unsent rows stay in their
// tables for the next start), community.db closes, and the process exits 0, within the manifest's 5 s.
const { within } = require('./graceful');
let profilesDone = null;
require('./graceful').gracefulStop({
    name: 'Community', server,
    stop: [
        () => { if (subscriptions) subscriptions.stop(); },
        () => { if (profiles) profilesDone = profiles.stop(); },
        () => { if (searchDocs) searchDocs.stop(); },
    ],
    close: [
        () => within(1000, profilesDone),
        () => within(1000, app.locals.relay && app.locals.relay.stop()),
        () => within(1500, require('./events').stop()),
        () => {
            const ev = require('./events').status();
            console.log(`[Community] stopped: subscriptions ${subscriptions ? 'stopped' : 'off'}, profile scan ${profiles && profiles.enabled ? 'stopped' : 'off'}, search scans ${searchDocs ? 'stopped' : 'off'}, relay ${config.discordRelay.enabled ? 'stopped' : 'off'}, outbox ${ev.enabled ? `stopped (${ev.pending} pending)` : 'off'}`);
            require('./db').closeDb();
        },
    ],
});
