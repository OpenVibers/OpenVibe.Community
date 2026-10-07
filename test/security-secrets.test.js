'use strict';
/** Service and Events secrets stay out of public responses and the stored outbox. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const secret = 'sentinel-not-a-secret-oauth';
    const eventsSecret = `whsec_${'cd'.repeat(32)}`;
    const t = await boot({ env: { OV_OAUTH_CLIENT_SECRET: secret, COMMUNITY_EVENTS_SECRET: eventsSecret } });
    await check('common public responses do not expose internal credentials', async () => {
        for (const path of ['/', '/pastes', '/pulse', '/api/health', '/api/ready', '/release.json', '/robots.txt', '/sitemap.xml', '/llms.txt', '/feed.xml']) {
            const r = await t.get(path);
            assert.ok(!r.text.includes(secret), path);
            assert.ok(!r.text.includes(eventsSecret), path);
            for (const [, value] of r.headers) assert.ok(!value.includes(secret) && !value.includes(eventsSecret), path);
        }
    });
    await check('the Events outbox stores no credentials', async () => {
        const rows = await t.db.prepare('SELECT envelope FROM event_outbox').all();
        const text = JSON.stringify(rows);
        assert.ok(!text.includes(secret));
        assert.ok(!text.includes(eventsSecret));
    });
    await t.close();
    done();
})().catch((e) => { console.error(e); process.exitCode = 1; });
