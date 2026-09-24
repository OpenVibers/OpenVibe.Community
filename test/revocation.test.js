'use strict';
/**
 * Revocation propagation in Community (WS-B task 4, Contracts 0.39.0 network.user.token_valid_after):
 * a signed delivery moves the person's cutoff once (a redelivery is a no-op, anything not from Network
 * changes nothing), and the viewer resolver then treats their older token as anonymous while a newer
 * token and other people still sign in.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { createRevocationStore } = require('openvibe-sdk/auth');
const { openDb } = require('../server/db');
const { createPulseConsumer, TOPICS } = require('../server/pulse/consumer');
const { createViewerResolver } = require('../server/identity/viewer');

const SECRET = `whsec_${'ab'.repeat(32)}`;
const db = openDb(':memory:');
const revocations = createRevocationStore(db, { table: 'token_revocations' });
const app = express();
app.use('/internal/events', createPulseConsumer({ db, secrets: [SECRET], revocations, log: { error() {}, log() {}, warn() {} } }).router);
const ANN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ', BEN = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPR';
const at = Date.now() - 5000;
const evt = (over = {}) => ({ event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN01', event_type: 'network.user.token_valid_after', version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
    subject: { type: 'user', id: ANN }, actor: { type: 'user', id: ANN },
    payload: { subject: { type: 'user', id: ANN }, valid_after: new Date(at).toISOString(), reason: 'signed_out_everywhere' }, ...over });

(async () => {
    assert.ok(TOPICS.includes('network.user.token_valid_after'), 'Community subscribes to it');
    const srv = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    const post = (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(`http://127.0.0.1:${srv.address().port}/internal/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    };
    const claimsOf = (subject, iatMs) => ({ sub: 7, subject_id: subject, username: 'someone', role: 'user', iat: Math.floor(iatMs / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
    let current = null;
    const viewers = createViewerResolver({ auth: { verify: async () => current }, config: { allowSandbox: false }, network: null, revocations });
    const who = async (claims) => { current = claims; return viewers.resolve({ headers: { authorization: 'Bearer opaque' }, cookies: {} }); };
    try {
        assert.strictEqual((await who(claimsOf(ANN, at - 60000))).kind, 'user', 'before the event');
        let r = await post(evt());
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'revoked']);
        assert.strictEqual((await post(evt())).json.duplicate, true, 'a redelivery is a no-op');
        assert.strictEqual((await who(claimsOf(ANN, at - 60000))).kind, 'anonymous', 'the older token no longer signs in');
        assert.strictEqual((await who(claimsOf(ANN, at + 1000))).kind, 'user', 'a newer token does');
        assert.strictEqual((await who(claimsOf(BEN, at - 60000))).kind, 'user', 'someone else is untouched');
        r = await post(evt({ event_id: 'evt_01JAB2C3D4E5F6G7H8J9K0MN02', source: 'live', payload: { subject: { type: 'user', id: BEN }, valid_after: new Date().toISOString(), reason: 'banned' } }));
        assert.strictEqual(r.json.outcome, 'ignored:source');
        assert.strictEqual((await who(claimsOf(BEN, at - 60000))).kind, 'user');
    } finally { srv.close(); }
    console.log('revocation: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
