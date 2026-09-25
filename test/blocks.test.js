'use strict';
/**
 * Platform blocks in Community (WS-E task 5, Contracts 0.49.0 network.block.changed): a signed delivery
 * updates the projection (newest revision per pair wins; redeliveries, older revisions, other sources and
 * malformed payloads change nothing). While alex has blocked sam, sam cannot reply in alex's forum threads,
 * reply to alex's comments (directly, or through a reply that joins alex's comment), comment on alex's
 * paste (comment threads and the paste API) or reply to alex's paste comments: 403 community.blocked in
 * the API, the plain message on the no-JS forms. Others are untouched; an unblock lifts it.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/app');

const SECRET = `whsec_${'cd'.repeat(32)}`;

(async () => {
    process.env.COMMUNITY_EVENTS_SECRET = SECRET;
    const t = await boot({
        authority: 'community', pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 },
        },
    });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const kim = net.addUser({ network_user_id: 11, username: 'kim', display_name: 'Kim' });
    const jwtOf = (u, id) => net.sign({ id, subject_id: u.subject_id, username: u.username, display_name: u.display_name, role: 'user' });
    const alexJwt = jwtOf(alex, 7), samJwt = jwtOf(sam, 9), kimJwt = jwtOf(kim, 11);
    const call = (path, { method = 'GET', cookie, json, form } = {}) => {
        const headers = {};
        let body;
        if (json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
        if (form !== undefined) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
        return t.get(path, { method, headers, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const deliver = (event) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(`${t.base}/internal/events`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } }).then(async (r) => ({ status: r.status, json: await r.json() }));
    };
    const block = (blocker, blocked, active, revision, over = {}) => ({
        event_id: ids.newId('event'), event_type: 'network.block.changed', version: 1, source: 'network', visibility: 'internal', timestamp: new Date().toISOString(),
        actor: { type: 'user', id: blocker }, subject: { type: 'user', id: blocker },
        payload: { blocker, blocked, active, revision, at: new Date().toISOString() }, ...over,
    });

    let threadSlug, alexPaste, kimPaste, streamThread, pasteThread, alexComment, kimReply;

    await check('Community subscribes to network.block.changed; the projection keeps the newest revision per pair', async () => {
        assert.ok(require('../server/pulse/consumer').TOPICS.includes('network.block.changed'));
        const first = block(alex.subject_id, sam.subject_id, true, 3);
        let r = await deliver(first);
        assert.deepStrictEqual([r.status, r.json.outcome], [200, 'blocks:blocked']);
        assert.strictEqual((await deliver(first)).json.duplicate, true, 'a redelivery is a no-op');
        r = await deliver(block(alex.subject_id, sam.subject_id, false, 2));
        assert.strictEqual(r.json.outcome, 'blocks:unchanged', 'an older revision never wins');
        r = await deliver(block(alex.subject_id, sam.subject_id, false, 9, { source: 'live' }));
        assert.strictEqual(r.json.outcome, 'ignored:source');
        const bad = block(alex.subject_id, sam.subject_id, false, 9); bad.payload.blocked = 'sam';
        assert.strictEqual((await deliver(bad)).json.outcome, 'ignored:payload');
        const blocks = require('../server/identity/blocks');
        assert.ok(blocks.hasBlocked(t.db, alex.subject_id, sam.subject_id));
        assert.ok(!blocks.hasBlocked(t.db, sam.subject_id, alex.subject_id), 'one direction');
    });

    await check('forum: no reply in a thread whose author blocked you (API problem and no-JS form); others reply', async () => {
        const th = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Alex asks', body: 'what do you think?' } });
        assert.strictEqual(th.status, 201, th.text);
        threadSlug = th.json().thread.slug;
        let r = await call(`/api/v1/spaces/general/threads/${threadSlug}/posts`, { method: 'POST', cookie: samJwt, json: { body: 'let me in' } });
        assert.strictEqual(r.status, 403);
        assert.match(r.headers.get('content-type'), /application\/problem\+json/);
        assert.deepStrictEqual([r.json().code, r.json().detail], ['community.blocked', 'You cannot reply in this thread: its author blocked you']);
        r = await call(`/api/v1/spaces/general/threads/${threadSlug}/posts`, { method: 'POST', cookie: kimJwt, json: { body: 'kim here' } });
        assert.strictEqual(r.status, 201, r.text);
        // The no-JS form: the thread page again, the plain message in the reply form, the draft kept.
        r = await call(`/s/general/t/${threadSlug}/reply`, { method: 'POST', cookie: samJwt, form: { body: 'my <draft>' } });
        assert.strictEqual(r.status, 403);
        assert.ok(r.text.includes('<p class="alert alert-error" role="alert">You cannot reply in this thread: its author blocked you</p>'), 'the message in the form');
        assert.ok(r.text.includes('my &lt;draft&gt;</textarea>'), 'the draft kept, escaped');
        // Sam's own thread: alex (the blocker) is not blocked by sam, so alex may reply there.
        const own = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: samJwt, json: { title: 'Sam asks', body: 'anyone?' } });
        r = await call(`/api/v1/spaces/general/threads/${own.json().thread.slug}/posts`, { method: 'POST', cookie: alexJwt, json: { body: 'me' } });
        assert.strictEqual(r.status, 201);
    });

    await check('comment threads: no reply to a comment whose author blocked you, nor to a reply that joins it', async () => {
        streamThread = (await call('/api/v1/comments/threads/resolve', { method: 'POST', cookie: kimJwt, json: { ref: { service: 'live', type: 'stream', id: '77' } } })).json().thread;
        const post = (who, json) => call(`/api/v1/comments/threads/${streamThread.id}/comments`, { method: 'POST', cookie: who, json });
        alexComment = (await post(alexJwt, { message: 'alex says' })).json().comment;
        kimReply = (await post(kimJwt, { message: 'kim answers', parent_id: alexComment.id })).json().comment;
        let r = await post(samJwt, { message: 'sam answers alex', parent_id: alexComment.id });
        assert.deepStrictEqual([r.status, r.json().code, r.json().detail], [403, 'community.blocked', 'You cannot reply to this comment: its author blocked you']);
        r = await post(samJwt, { message: 'sam answers kim', parent_id: kimReply.id });
        assert.strictEqual(r.status, 403, 'a reply to a reply joins alex\'s comment');
        r = await post(samJwt, { message: 'sam on the stream' });
        assert.strictEqual(r.status, 201, 'the thread itself is nobody\'s');
        const samTop = r.json().comment;
        r = await post(kimJwt, { message: 'kim answers sam', parent_id: samTop.id });
        assert.strictEqual(r.status, 201);
        r = await post(alexJwt, { message: 'alex answers sam', parent_id: samTop.id });
        assert.strictEqual(r.status, 201, 'the blocker is not blocked');
    });

    await check('pastes: no comment on a paste whose owner blocked you (comment threads and the paste API), no reply to their comments', async () => {
        alexPaste = (await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'alex paste' } })).json().slug;
        kimPaste = (await call('/api/pastes', { method: 'POST', cookie: kimJwt, json: { content: 'kim paste' } })).json().slug;
        // The paste API (the paste page's comments).
        let r = await call(`/api/pastes/${alexPaste}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi alex' } });
        assert.deepStrictEqual([r.status, r.json()], [403, { error: 'You cannot comment on this paste: its owner blocked you', code: 'community.blocked' }]);
        r = await call(`/api/pastes/${alexPaste}/comments`, { method: 'POST', cookie: kimJwt, json: { message: 'nice' } });
        assert.strictEqual(r.status, 201, r.text);
        const onKim = (await call(`/api/pastes/${kimPaste}/comments`, { method: 'POST', cookie: alexJwt, json: { message: 'alex on kim' } })).json().comment;
        r = await call(`/api/pastes/${kimPaste}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'sam replies', parent_id: onKim.id } });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'community.blocked'], 'alex\'s comment on kim\'s paste');
        r = await call(`/api/pastes/${kimPaste}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'sam on kim' } });
        assert.strictEqual(r.status, 201);
        // A comment thread opened on alex's paste.
        pasteThread = (await call('/api/v1/comments/threads/resolve', { method: 'POST', cookie: kimJwt, json: { ref: { service: 'community', type: 'paste', id: alexPaste } } })).json().thread;
        r = await call(`/api/v1/comments/threads/${pasteThread.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi' } });
        assert.deepStrictEqual([r.status, r.json().detail], [403, 'You cannot comment on this paste: its owner blocked you']);
        // Its no-JS page shows the message in the form.
        r = await call(`/c/${pasteThread.id}`, { method: 'POST', cookie: samJwt, form: { message: 'from the page' } });
        assert.strictEqual(r.status, 403);
        assert.ok(r.text.includes('You cannot comment on this paste: its owner blocked you'));
        assert.ok(r.text.includes('from the page</textarea>'));
        r = await call(`/c/${pasteThread.id}`, { method: 'POST', cookie: kimJwt, form: { message: 'kim from the page' } });
        assert.strictEqual(r.status, 303);
    });

    await check('an unblock lifts it', async () => {
        const r = await deliver(block(alex.subject_id, sam.subject_id, false, 4));
        assert.strictEqual(r.json.outcome, 'blocks:unblocked');
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${threadSlug}/posts`, { method: 'POST', cookie: samJwt, json: { body: 'hello again' } })).status, 201);
        assert.strictEqual((await call(`/api/v1/comments/threads/${streamThread.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi alex', parent_id: alexComment.id } })).status, 201);
        assert.strictEqual((await call(`/api/pastes/${alexPaste}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi alex' } })).status, 201);
        assert.strictEqual((await call(`/api/v1/comments/threads/${pasteThread.id}/comments`, { method: 'POST', cookie: samJwt, json: { message: 'hi' } })).status, 201);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
