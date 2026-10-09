'use strict';
/**
 * What people wear, on Community (plan T21 "equip everywhere"): a person's name carries their Network subject
 * (data-ov-subject) so openvibe-shared items.js gives it their name effect; AI, relayed and system authors never do.
 * Every page names items.js + items.css in <meta name="ov-items"> (community.js loads them only when a page shows
 * someone), and the CSP lets the page read OpenVibe.Inventory's public equipped sets.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/app');
const { authorHtml } = require('../server/render/pages');

const form = (obj) => ({ method: 'POST', body: new URLSearchParams(obj).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

(async () => {
    const t = await boot({ authority: 'community', appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });

    await check('a person\'s name carries their subject; AI, relayed and system names do not', async () => {
        const S = 'usr_01JZ0000000000000000000AAA';
        assert.match(authorHtml({ subject: S, username: 'ana', display_name: 'Ana' }), new RegExp(`<span data-ov-subject="${S}">Ana</span>`));
        assert.match(authorHtml({ owner_subject: S, username: 'ana', display_name: 'Ana' }), /data-ov-subject=/, 'a paste\'s owner');
        assert.match(authorHtml({ author_subject: S, username: 'ana', display_name: 'Ana' }), /data-ov-subject=/, 'a comment\'s author');
        for (const p of [{ subject: S, display_name: 'OpenVibe AI', is_ai: true }, { owner_subject: S, display_name: 'AI', origin: 'ai' }, { subject: S, display_name: 'x', is_relay: true }, { subject: S, display_name: 'OpenVibe', is_system: true }, { subject: 'not-a-subject', display_name: 'y' }]) {
            assert.ok(!/data-ov-subject/.test(authorHtml(p, { link: false })), JSON.stringify(p));
        }
    });

    await check('a thread page marks its author and names the items files; the CSP reaches Inventory', async () => {
        const ok = await t.get('/s/general/new', { ...form({ title: 'Wearing things', body: 'Look at my name.' }), cookies: [`ov_token=${alexJwt}`] });
        assert.strictEqual(ok.status, 303, ok.text);
        const r = await t.get(ok.headers.get('location'));
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`<span data-ov-subject="${alex.subject_id}">Alex</span>`), `the author name is marked`);
        assert.match(r.text, /<meta name="ov-items" content="\/shared\/items\.js\?v=[A-Za-z0-9_-]+ \/shared\/items\.css\?v=[A-Za-z0-9_-]+">/);
        assert.match(r.headers.get('content-security-policy') || '', /connect-src[^;]*https:\/\/inventory\.openvibe\.network/);
        const js = await t.get('/shared/items.js');
        assert.strictEqual(js.status, 200, 'the site serves openvibe-shared items.js');
        assert.strictEqual((await t.get('/shared/items.css')).status, 200);
    });

    await check('community.js loads items.js only when a page shows someone, and again after each page move', async () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'community.js'), 'utf8');
        assert.match(src, /querySelector\('\[data-ov-subject\]'\)/);
        assert.match(src, /OpenVibeItems\.decorate\(document\)/);
        assert.match(src, /ov:boost:load', function \(\) \{ wirePage\(\); wearItems\(\); \}/);
    });

    await t.close();
    done();
})();
