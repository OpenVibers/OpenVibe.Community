'use strict';
/**
 * Link spam from signed-out posters (server/pastes/spam.js): a would-be public paste with no account that advertises a
 * link is kept but unlisted (a secret slug, never listed or indexed), and the answer says why; code or notes with a
 * link in longer text, a signed-in person's paste and an AI paste are never touched.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { linkSpam } = require('../server/pastes/spam');

const LONG_NOTES = `${'The build failed at the link step; the log below shows the missing symbol and the flags used. '.repeat(8)}\nSee https://github.com/example/repo/issues/12 for the same error.`;

(async () => {
    await check('the rule: three links, a link with advertising words, or a paste that is mostly its link', () => {
        // 2026-10-22's spam paste, in shape: a short recruitment post with one link.
        assert.deepStrictEqual(linkSpam({ title: 'Studio creator opportunity | Leeds | 18+', content: 'Paid weekly, apply now: https://example.test/apply' }), { unlist: true, reason: 'promotion', links: 1 });
        assert.strictEqual(linkSpam({ content: 'a https://a.test b https://b.test c https://c.test' }).reason, 'links');
        assert.strictEqual(linkSpam({ content: 'look www.example.test' }).reason, 'mostly_link');
        assert.deepStrictEqual(linkSpam({ content: LONG_NOTES }), { unlist: false, reason: null, links: 1 }, 'notes with one link in a longer text');
        assert.deepStrictEqual(linkSpam({ content: 'console.log(1)' }), { unlist: false, reason: null, links: 0 });
    });

    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 } });
    const net = t.network;
    const ana = net.addUser({ network_user_id: 21, username: 'ana', display_name: 'Ana' });
    const anaJwt = net.sign({ id: 21, subject_id: ana.subject_id, username: 'ana', display_name: 'Ana', role: 'user' });
    const post = (json, { cookie, token, ip = '198.51.100.7' } = {}) => {
        const headers = { 'content-type': 'application/json', 'x-forwarded-for': ip };
        if (token) headers.authorization = `Bearer ${token}`;
        return t.get('/api/pastes', { method: 'POST', headers, body: JSON.stringify(json), cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const SPAM = { title: 'Studio creator opportunity | 18+', content: 'Paid weekly, apply now: https://example.test/apply', visibility: 'public' };

    await check('signed out, an advert for a link is kept unlisted with a secret slug, and the answer says why', async () => {
        const r = await post(SPAM);
        assert.strictEqual(r.status, 201, r.text);
        const out = r.json();
        assert.strictEqual(out.paste.visibility, 'unlisted');
        assert.strictEqual(out.unlisted_reason, 'promotion');
        assert.match(out.notice, /Sign in to publish/);
        assert.ok(out.slug.length >= 16, 'a secret slug, not a guessable adjective-noun one');
        const list = await t.get('/api/pastes?limit=50');
        assert.ok(!list.text.includes('creator opportunity'), 'not in the public list');
        const page = await t.get(`/p/${out.slug}`);
        assert.strictEqual(page.status, 200, 'still opens by its link');
    });

    await check('signed out, notes with a link in longer text stay public; signed in, the same advert stays public', async () => {
        const notes = await post({ title: 'Build log', content: LONG_NOTES });
        assert.strictEqual(notes.json().paste.visibility, 'public');
        assert.strictEqual(notes.json().notice, undefined);
        const mine = await post(SPAM, { cookie: anaJwt });
        assert.strictEqual(mine.json().paste.visibility, 'public', 'a person with an account is answerable for their paste');
    });

    await check('a signed-out paste a service forwards is checked; an AI paste never is', async () => {
        const r = await post({ ...SPAM, content: 'Moment: https://openvibe.live/@x and https://openvibe.video/v/1 and https://openvibe.video/c/2' }, {
            token: net.signService({ cap: ['community.paste.create'] }), ip: '127.0.0.1',
        });
        assert.strictEqual(r.status, 201, r.text);
        // A service without X-OV-Origin: ai is a signed-out person's paste forwarded (Live's /api/pastes): checked.
        assert.strictEqual(r.json().paste.visibility, 'unlisted');
        const ai = await t.get('/api/pastes', {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${net.signService({ cap: ['community.paste.create'] })}`, 'x-ov-origin': 'ai' },
            body: JSON.stringify({ title: 'From the stream', content: 'Clip: https://openvibe.video/c/2 https://openvibe.video/c/3 https://openvibe.video/c/4' }),
        });
        assert.strictEqual(ai.status, 201, ai.text);
        assert.strictEqual(ai.json().paste.visibility, 'public');
    });

    await t.close();
    done();
})();
