'use strict';
/**
 * Security regressions:
 *   - developer-app / module tokens (sub app:… / mod:…) act only for the person who authorized
 *     them (on_behalf_of); X-OV-Subject can never make them someone else, and sandbox app tokens
 *     are refused.
 *   - burn-after-read pastes: every way of reading the content counts as the read (?no_view=1,
 *     download, fork), and they never appear in public lists, search, feeds or the home page.
 *   - a fork of an unlisted paste is not published as a public paste.
 *   - unlisted (and private) pastes get slugs nobody can guess; existing slugs keep working.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({
        authority: 'community',
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } },
    });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const CREATE = 'community.paste.create', WRITE = 'community.paste.write', POST = 'community.post.create';
    const APP = 'app:app_01HZX3K5V7Q9M2N4P6R8T0W2Y4';
    // An app token carries its developer project and env, as Network's do (identity.service-token-claims 1.2.0).
    const PROJECT = 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
    const appToken = ({ cap = [CREATE, POST], env = 'production', onBehalfOf = null, sub = APP, actorType = 'app' } = {}) => net.signService({
        sub, actorType, cap, extra: { env, project_id: PROJECT, ns: [PROJECT], ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}) },
    });

    const call = (path, { method = 'GET', token, cookie, headers = {}, json, ip } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (ip) h['x-forwarded-for'] = ip;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };

    // ── developer apps cannot name someone else in X-OV-Subject ──
    const priv = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'alex private notes', visibility: 'private' } });
    assert.strictEqual(priv.status, 201, priv.text);
    const privSlug = priv.json().slug;
    const thread = await call('/api/v1/spaces/general/threads', { method: 'POST', cookie: alexJwt, json: { title: 'Alex thread', body: 'original words' } });
    assert.strictEqual(thread.status, 201, thread.text);
    const alexPostId = thread.json().post.id;

    await check('an app token naming a victim in X-OV-Subject cannot read their private paste', async () => {
        const r = await call(`/api/pastes/${privSlug}`, { token: appToken(), headers: { 'x-ov-subject': alex.subject_id } });
        assert.notStrictEqual(r.status, 200, `private paste leaked to a third-party app: ${r.text}`);
        const list = await call('/api/pastes?username=alex&include_unlisted=1', { token: appToken(), headers: { 'x-ov-subject': alex.subject_id } });
        assert.ok(list.status !== 200 || !list.json().pastes.some((p) => p.slug === privSlug), 'private paste listed to a third-party app');
    });

    await check('an app token naming a victim in X-OV-Subject cannot edit their forum post or post as them', async () => {
        const r = await call(`/api/v1/posts/${alexPostId}`, { method: 'PUT', token: appToken(), headers: { 'x-ov-subject': alex.subject_id }, json: { body: 'defaced' } });
        assert.notStrictEqual(r.status, 200, `post edited by a third-party app: ${r.text}`);
        const post = t.db.prepare('SELECT body_markdown FROM posts WHERE id = ?').get(alexPostId);
        assert.strictEqual(post.body_markdown, 'original words');
        const p = await call('/api/pastes', { method: 'POST', token: appToken(), headers: { 'x-ov-subject': alex.subject_id }, json: { content: 'written as alex' } });
        assert.strictEqual(p.status, 403, p.text);
    });

    await check('an app token acts for the person who authorized it (on_behalf_of), and only for them', async () => {
        const own = await call('/api/pastes', { method: 'POST', token: appToken({ onBehalfOf: sam.subject_id }), json: { content: 'sam via an app' } });
        assert.strictEqual(own.status, 201, own.text);
        assert.strictEqual(own.json().paste.owner_subject, sam.subject_id);
        const other = await call('/api/pastes', { method: 'POST', token: appToken({ onBehalfOf: sam.subject_id }), headers: { 'x-ov-subject': alex.subject_id }, json: { content: 'x' } });
        assert.strictEqual(other.status, 403, other.text);
        const modTok = appToken({ sub: 'mod:mod_01HZX3K5V7Q9M2N4P6R8T0W2Y4', actorType: 'mod' });
        const mod = await call(`/api/pastes/${privSlug}`, { token: modTok, headers: { 'x-ov-subject': alex.subject_id } });
        assert.notStrictEqual(mod.status, 200, 'module tokens are not trusted with X-OV-Subject either');
        // First-party services keep acting for the subject they name.
        const svc = await call(`/api/pastes/${privSlug}`, { token: net.signService({ cap: [WRITE] }), headers: { 'x-ov-subject': alex.subject_id } });
        assert.strictEqual(svc.status, 200, svc.text);
    });

    await check('sandbox app tokens are refused', async () => {
        const r = await call('/api/pastes', { method: 'POST', token: appToken({ env: 'sandbox' }), json: { content: 'sandbox' } });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.json().code, 'token.sandbox_refused', r.text);
    });

    // ── burn after read ──────────────────────────────────────
    const burnPaste = async (content) => {
        const r = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { title: 'Burner', content, burn_after_read: true } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().slug;
    };

    await check('burn-after-read pastes stay out of lists, search, the feed and the home page', async () => {
        const slug = await burnPaste('BURNSECRET-one two three');
        const list = await call('/api/pastes?limit=200');
        assert.ok(!list.json().pastes.some((p) => p.slug === slug), 'listed publicly');
        const search = await call('/api/pastes?search=BURNSECRET');
        assert.strictEqual(search.json().pastes.length, 0, 'content searchable');
        const feed = await call('/feed.xml');
        assert.ok(!feed.text.includes('BURNSECRET') && !feed.text.includes(slug), 'in the RSS feed');
        const home = await call('/');
        assert.ok(!home.text.includes('BURNSECRET'), 'previewed on the home page');
        const mine = await call('/api/pastes/by-user/alex', { cookie: alexJwt });
        assert.ok(mine.json().pastes.some((p) => p.slug === slug), 'the owner still sees it');
    });

    await check('?no_view=1 does not let a reader skip the burn', async () => {
        const slug = await burnPaste('burn me once');
        const first = await call(`/api/pastes/${slug}?no_view=1`, { cookie: samJwt });
        assert.strictEqual(first.status, 200, first.text);
        const second = await call(`/api/pastes/${slug}?no_view=1`, { cookie: samJwt });
        assert.strictEqual(second.status, 410, `read twice: ${second.text}`);
    });

    await check('downloading a burn-after-read paste is the read', async () => {
        const slug = await burnPaste('download burns');
        const dl = await call(`/p/${slug}/download`, { cookie: samJwt });
        assert.strictEqual(dl.status, 200);
        const again = await call(`/p/${slug}/download`, { cookie: samJwt });
        assert.notStrictEqual(again.status, 200, 'downloaded twice');
    });

    await check('a burn-after-read paste cannot be forked into a lasting copy by someone else', async () => {
        const slug = await burnPaste('fork me not');
        const f = await call(`/api/pastes/${slug}/fork`, { method: 'POST', cookie: samJwt, json: {} });
        assert.notStrictEqual(f.status, 201, `forked: ${f.text}`);
    });

    // ── forks keep an unlisted paste unlisted ────────────────
    await check('forking an unlisted paste does not publish it', async () => {
        const u = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'UNLISTEDSECRET body', visibility: 'unlisted' } });
        assert.strictEqual(u.status, 201, u.text);
        const f = await call(`/api/pastes/${u.json().slug}/fork`, { method: 'POST', cookie: samJwt, json: {} });
        assert.strictEqual(f.status, 201, f.text);
        assert.notStrictEqual(f.json().paste.visibility, 'public');
        const search = await call('/api/pastes?search=UNLISTEDSECRET');
        assert.strictEqual(search.json().pastes.length, 0, 'the fork is listed publicly');
        const pub = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'public body' } });
        const pf = await call(`/api/pastes/${pub.json().slug}/fork`, { method: 'POST', cookie: samJwt, json: {} });
        assert.strictEqual(pf.json().paste.visibility, 'public', 'forks of public pastes stay public');
    });

    // ── unlisted slugs cannot be guessed ─────────────────────
    await check('new unlisted/private pastes get a high-entropy slug; public ones keep the short form; old slugs still open', async () => {
        const SECRET = /^[a-z]+-[a-z]+-[A-Za-z0-9]{16}$/;
        const SHORT = /^[a-z]+-[a-z]+-\d{2,4}$/;
        const slugs = new Set();
        for (const [who, visibility] of [[{ cookie: alexJwt }, 'unlisted'], [{ cookie: alexJwt }, 'private'], [{}, 'unlisted'], [{}, 'private']]) {
            const r = await call('/api/pastes', { method: 'POST', ...who, json: { content: `hidden ${visibility}`, visibility }, ip: '192.0.2.61' });
            assert.strictEqual(r.status, 201, r.text);
            assert.match(r.json().slug, SECRET, `${visibility} (${who.cookie ? 'signed in' : 'anonymous'})`);
            slugs.add(r.json().slug);
        }
        const fork = await call(`/api/pastes/${[...slugs][0]}/fork`, { method: 'POST', cookie: samJwt, json: {} });
        assert.strictEqual(fork.status, 201, fork.text);
        assert.match(fork.json().slug, SECRET, 'a fork of an unlisted paste is unlisted, with a secret slug');
        const service = await call('/api/pastes', { method: 'POST', token: net.signService({ cap: [CREATE] }), headers: { 'x-ov-subject': alex.subject_id }, json: { content: 'svc hidden', visibility: 'unlisted' } });
        assert.strictEqual(service.status, 201, service.text);
        assert.match(service.json().slug, SECRET, 'service-created unlisted pastes too');
        // A service forwarding a person's body (Live's /api/pastes) cannot give an unlisted paste a chosen slug.
        const named = await call('/api/pastes', { method: 'POST', token: net.signService({ cap: [CREATE] }), json: { content: 'weak', visibility: 'unlisted', slug: 'aaa' } });
        assert.strictEqual(named.status, 201, named.text);
        assert.match(named.json().slug, SECRET, 'a named slug is ignored for an unlisted paste');
        const namedPub = await call('/api/pastes', { method: 'POST', token: net.signService({ cap: [CREATE] }), json: { content: 'imported', visibility: 'public', slug: 'imported-public-1' } });
        assert.strictEqual(namedPub.json().slug, 'imported-public-1', 'a service still names a public paste\'s slug');
        const pub = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { content: 'public words' } });
        assert.match(pub.json().slug, SHORT, 'public pastes are listed anyway: short slug');
        // A paste made before this change (short slug, unlisted) still opens by its slug.
        t.db.prepare("INSERT INTO pastes (slug, type, title, content, language, visibility) VALUES ('calm-otter-42', 'paste', 'old', 'old unlisted words', 'text', 'unlisted')").run();
        const old = await call('/api/pastes/calm-otter-42');
        assert.strictEqual(old.status, 200, old.text);
        assert.strictEqual(old.json().paste.content, 'old unlisted words');
        assert.strictEqual((await call('/p/calm-otter-42/raw')).status, 200);
        // The secret part is really random.
        const { generateSlug } = require('../server/pastes/store');
        const many = new Set(Array.from({ length: 2000 }, () => generateSlug(t.db, { secret: true }).split('-')[2]));
        assert.strictEqual(many.size, 2000);
    });

    await t.close();
    done();
})();
