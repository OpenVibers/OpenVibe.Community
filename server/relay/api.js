'use strict';

/**
 * /api/v1/relay — Discord relay administration, staff only (an admin/global_mod browser, or a
 * service holding community.comment.moderate: acting as itself, or vouching with X-OV-Staff).
 *
 *   GET  /status                                                the queue by status, the Events worker (cursor, lag,
 *                                                               last error, gaps) and the inbound gateway's state
 *   GET  /deliveries?status=pending|delivered|failed|dropped|skipped&action=create|edit|delete&limit=
 *                                                               what was sent, what is failing and why (failed = the dead letters)
 *   POST /deliveries/:id/retry                                  queue a delivery again, with a fresh attempt budget
 *   POST /deliveries/:id/drop                                   give up on a waiting or failed one (kept as 'dropped')
 *   GET  /inbound?all=1&limit=                                  messages from Discord that did not become posts, and why
 *   POST /inbound/:id/dismiss                                   mark one seen
 *   GET  /mappings                                              space → webhook variable name, Discord channel/thread, inbound
 *   POST /mappings { space, webhook_url_ref, enabled?, discord_channel_id?, discord_thread_id?, inbound? }
 *                                                               map a space (the URL stays in the env; allow-listed names only)
 *   PUT  /mappings/:id { enabled?, inbound?, discord_channel_id?, discord_thread_id? }
 *
 * Responses never contain a webhook URL or the bot token, only variable names and whether they are set.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { run, jsonBody, fail, intIn } = require('../http/v1');
const { discussionModerator } = require('../identity/capabilities');
const forumStore = require('../forum/store');
const { SNOWFLAKE, DELIVERY_STATUSES } = require('./discord');

function createRelayApi({ relay, db, viewers, inbound = null }) {
    const router = express.Router();
    router.use(contracts.http.middleware());
    router.use(viewers.middleware());

    router.use((req, res, next) => {
        const v = req.viewer;
        if (discussionModerator(v)) return next();
        if (v.kind === 'anonymous') return contracts.http.sendProblem(res, 401, 'auth.required', { detail: 'Sign in as staff', ctx: req.ov });
        return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: 'Relay administration is for staff', ctx: req.ov });
    });

    const idOf = (req) => (/^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : fail(404, 'route.not_found', 'Not found'));
    /** Discord ids in a mapping body: digits, or null/'' to clear; undefined when absent. */
    function discordIds(b) {
        const out = {};
        for (const k of ['discord_channel_id', 'discord_thread_id']) {
            if (b[k] === undefined) continue;
            if (b[k] !== null && b[k] !== '' && !SNOWFLAKE.test(String(b[k]))) fail(400, 'relay.invalid_discord_id', `${k} is a Discord id (15 to 21 digits), or null`);
            out[k] = b[k] === '' ? null : b[k];
        }
        return out;
    }

    router.get('/status', run(() => relay.status()));
    router.get('/deliveries', run((req) => {
        const status = DELIVERY_STATUSES.includes(req.query.status) ? req.query.status : null;
        const action = ['create', 'edit', 'delete'].includes(req.query.action) ? req.query.action : null;
        return { enabled: relay.enabled, deliveries: relay.listDeliveries({ status, action, limit: intIn(req.query.limit, 50, 1, 200) }) };
    }));
    router.post('/deliveries/:id/retry', run((req) => {
        if (!relay.retry(idOf(req))) fail(404, 'relay.delivery_not_found', 'No such delivery waiting to be sent');
        return { ok: true };
    }));
    router.post('/deliveries/:id/drop', run((req) => {
        if (!relay.drop(idOf(req))) fail(404, 'relay.delivery_not_found', 'No such pending or failed delivery');
        return { ok: true };
    }));
    router.get('/inbound', run((req) => ({
        enabled: !!inbound, failures: inbound ? inbound.listFailures({ all: req.query.all === '1', limit: intIn(req.query.limit, 50, 1, 200) }) : [],
    })));
    router.post('/inbound/:id/dismiss', run((req) => {
        if (!inbound || !inbound.dismiss(idOf(req))) fail(404, 'relay.inbound_not_found', 'No such inbound failure to dismiss');
        return { ok: true };
    }));
    router.get('/mappings', run(() => ({ enabled: relay.enabled, mappings: relay.listMappings() })));
    router.post('/mappings', jsonBody, run((req) => {
        const b = req.body || {};
        const space = forumStore.getSpace(db, String(b.space || ''));
        if (!space) fail(400, 'relay.invalid_space', 'Unknown space');
        const ref = String(b.webhook_url_ref || '');
        if (!relay.ENV_NAME.test(ref)) fail(400, 'relay.invalid_ref', 'webhook_url_ref is the NAME of an environment variable (A-Z, 0-9, _), never the URL');
        if (!relay.refAllowed(ref)) fail(400, 'relay.ref_not_allowed', 'webhook_url_ref must be an allowed webhook variable (DISCORD_RELAY_WEBHOOK_VARS, else DISCORD_WEBHOOK_*)');
        const ids = discordIds(b);
        return { mapping: relay.addMapping({ space_id: space.id, webhook_url_ref: ref, enabled: b.enabled !== false, ...ids, inbound: b.inbound === undefined ? undefined : !!b.inbound }) };
    }, 201));
    router.put('/mappings/:id', jsonBody, run((req) => {
        const b = req.body || {};
        const fields = { ...discordIds(b) };
        if (b.enabled !== undefined) fields.enabled = !!b.enabled;
        if (b.inbound !== undefined) fields.inbound = !!b.inbound;
        const m = relay.updateMapping(idOf(req), fields);
        if (!m) fail(404, 'relay.mapping_not_found', 'No such mapping');
        return { mapping: m };
    }));

    router.use((req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'Not found', ctx: req.ov }));
    return router;
}

module.exports = { createRelayApi };
