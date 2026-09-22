'use strict';

/**
 * OpenVibe.Community — process entry. `node server/index.js`
 * Listens on PORT (4200) behind nginx; see deploy/ for the unit and vhost.
 */
const config = require('./config');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.port, config.host, () => {
    console.log(`[Community] ${config.nodeEnv} on http://${config.host}:${config.port} → ${config.baseUrl}`);
    console.log(config.pastesAuthority === 'community'
        ? `[Community] pastes: this site is the authority (${config.dbPath}), identity via ${config.networkUrl}`
        : `[Community] pastes via ${config.liveInternalUrl}/api/pastes, identity via ${config.networkUrl}`);
});
server.keepAliveTimeout = 65_000;

function shutdown(signal) {
    console.log(`[Community] ${signal} — closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
