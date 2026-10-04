'use strict';
/**
 * Submissions: a signed-in person submits (API or the no-JS form) → pending, seen only by them and
 * moderators → a moderator accepts → public on its page, in the list and in Pulse (origin user, the
 * author as actor); rejected ones never reach Pulse; the author withdraws; non-moderators cannot review;
 * signed-out visitors and services cannot submit; identity never comes from the body; a form from
 * another site is refused.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

const form = (obj, headers = {}) => ({ method: 'POST', body: new URLSearchParams(obj).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
const has = (html, s, msg) => assert.ok(html.includes(s), msg || `expected to find: ${s}`);

(async () => {
    const t = await boot({ authority: 'community' });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const bossSubject = ids.newId('user');
    const bossJwt = net.sign({ id: 1, subject_id: bossSubject, username: 'boss', display_name: 'Boss', role: 'admin' });
    const as = (jwt, opts = {}) => ({ ...opts, cookies: [`ov_token=${jwt}`] });
    const api = (path, { method = 'GET', token, json, headers = {} } = {}) => t.get(`/api/v1/submissions${path}`, {
        method,
        headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const row = async (slug) => await t.db.prepare('SELECT * FROM submissions WHERE slug = ?').get(slug);
    const pulseItem = async (slug) => await t.db.prepare("SELECT * FROM pulse_items WHERE source_service = 'community' AND source_type = 'submission' AND source_id = ?").get(slug);
    const count = async () => Number((await t.db.prepare('SELECT COUNT(*) AS n FROM submissions').get()).n);
    const submitApi = async (body, token = alexJwt) => { const r = await api('', { method: 'POST', token, json: body }); assert.strictEqual(r.status, 201, r.text); return r.json().submission; };

    let slug;   // the no-JS submission the next checks follow

    await check('signed-out visitors cannot submit (API 401, form → sign in) and see a sign-in prompt instead of the form', async () => {
        const before = await count();
        const r = await api('', { method: 'POST', json: { kind: 'idea', title: 'Anonymous idea', body: 'x' } });
        assert.strictEqual(r.status, 401, r.text);
        assert.strictEqual(r.json().code, 'auth.required');
        const f = await t.get('/submissions', form({ kind: 'idea', title: 'Anonymous idea', body: 'x' }));
        assert.strictEqual(f.status, 303);
        assert.ok(f.headers.get('location').startsWith('/auth/login?next=%2Fsubmissions'), f.headers.get('location'));
        assert.strictEqual(await count(), before);
        const page = await t.get('/submissions');
        assert.strictEqual(page.status, 200);
        has(page.text, 'Sign in with your OpenVibe account');
        assert.ok(!page.text.includes('action="/submissions"'), 'no submit form when signed out');
    });

    await check('the no-JS form submits as the signed-in person → pending, seen only by its author', async () => {
        const page = await t.get('/submissions', as(alexJwt));
        has(page.text, '<form class="paste-form" method="post" action="/submissions"');
        const r = await t.get('/submissions', as(alexJwt, form({ kind: 'clip', title: 'Best play of the week', url: 'https://openvibe.live/clip/abc', body: 'Watch the **ending**.' })));
        assert.strictEqual(r.status, 303, r.text);
        slug = r.headers.get('location').replace('/submissions/', '');
        assert.ok(/^[a-z]+-[a-z]+-\d+$/.test(slug), slug);
        const s = await row(slug);
        assert.deepStrictEqual([s.kind, s.title, s.url, s.status, s.author_subject, s.reviewer_subject], ['clip', 'Best play of the week', 'https://openvibe.live/clip/abc', 'pending', alex.subject_id, null]);
        const own = await t.get(`/submissions/${slug}`, as(alexJwt));
        assert.strictEqual(own.status, 200);
        has(own.text, 'Pending review');
        has(own.text, '<strong>ending</strong>');
        has(own.text, 'noindex,nofollow');
        has(own.text, `action="/submissions/${slug}/withdraw"`);
        assert.ok(!own.text.includes(`action="/submissions/${slug}/review"`), 'the author does not review');
    });

    await check('pending is not public: page 404 for others, not listed, not in Pulse', async () => {
        assert.strictEqual((await t.get(`/submissions/${slug}`)).status, 404);
        assert.strictEqual((await t.get(`/submissions/${slug}`, as(samJwt))).status, 404);
        assert.strictEqual((await api(`/${slug}`)).status, 404);
        assert.ok(!(await t.get('/submissions')).text.includes('Best play of the week'));
        assert.deepStrictEqual((await api('')).json().submissions.map((s) => s.slug), []);
        assert.strictEqual((await api('?status=pending', { token: samJwt })).status, 403);
        assert.strictEqual(await pulseItem(slug), undefined);
        const mine = (await api('?mine=1', { token: alexJwt })).json().submissions;
        assert.deepStrictEqual(mine.map((s) => [s.slug, s.status]), [[slug, 'pending']]);
    });

    await check('non-moderators cannot review (404 for what they cannot see, 403 otherwise), page or API', async () => {
        assert.strictEqual((await api(`/${slug}/review`, { method: 'POST', token: samJwt, json: { decision: 'accept' } })).status, 404);
        const own = await api(`/${slug}/review`, { method: 'POST', token: alexJwt, json: { decision: 'accept' } });
        assert.strictEqual(own.status, 403);
        assert.strictEqual(own.json().code, 'submission.moderators_only');
        assert.strictEqual((await t.get(`/submissions/${slug}/review`, as(alexJwt, form({ decision: 'accept' })))).status, 403);
        assert.strictEqual((await api(`/${slug}/review`, { method: 'POST', json: { decision: 'accept' } })).status, 401);
        assert.strictEqual((await t.get('/submissions/review', as(alexJwt))).status, 403);
        assert.strictEqual((await t.get('/submissions/review')).status, 303);
        assert.strictEqual((await row(slug)).status, 'pending');
    });

    await check('a moderator sees the queue and accepts with the no-JS form → public page, list and Pulse', async () => {
        assert.ok(!(await t.get('/submissions', as(bossJwt))).text.includes('Best play of the week'), 'the list is accepted ones, for moderators too');
        const queue = await t.get('/submissions/review', as(bossJwt));
        assert.strictEqual(queue.status, 200);
        has(queue.text, 'Best play of the week');
        const page = await t.get(`/submissions/${slug}`, as(bossJwt));
        has(page.text, `action="/submissions/${slug}/review"`);
        const r = await t.get(`/submissions/${slug}/review`, as(bossJwt, form({ decision: 'accept', note: 'Great one' })));
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual(r.headers.get('location'), `/submissions/${slug}`);
        const s = await row(slug);
        assert.deepStrictEqual([s.status, s.reviewer_subject, s.review_note], ['accepted', bossSubject, 'Great one']);
        assert.ok(s.reviewed_at);

        const pub = await t.get(`/submissions/${slug}`);
        assert.strictEqual(pub.status, 200);
        has(pub.text, `<link rel="canonical" href="https://openvibe.community/submissions/${slug}">`);
        has(pub.text, '<meta property="og:type" content="article">');
        has(pub.text, '<meta property="og:title" content="Best play of the week · OpenVibe.Community">');
        has(pub.text, 'index,follow');
        assert.ok(!pub.text.includes('Great one'), 'the review note is for the author and moderators');
        assert.ok(!pub.text.includes(`/submissions/${slug}/withdraw`) && !pub.text.includes(`/submissions/${slug}/review"`));
        has((await t.get(`/submissions/${slug}`, as(alexJwt))).text, 'Great one');
        has((await t.get('/submissions')).text, 'Best play of the week');
        has((await t.get('/submissions?kind=clip')).text, 'Best play of the week');
        assert.ok(!(await t.get('/submissions?kind=art')).text.includes('Best play of the week'));
        const listed = (await api('')).json().submissions;
        assert.deepStrictEqual(listed.map((x) => [x.slug, x.author.subject, x.review_note]), [[slug, alex.subject_id, null]]);

        const it = await pulseItem(slug);
        assert.deepStrictEqual([it.title, it.url, it.actor_subject, it.origin, it.visibility], ['Best play of the week', `https://openvibe.community/submissions/${slug}`, alex.subject_id, 'user', 'public']);
        const feed = (await t.get('/api/v1/pulse?origin=user')).json().items;
        assert.ok(feed.some((i) => i.source.type === 'submission' && i.source.id === slug && i.actor.subject === alex.subject_id));
        has((await t.get('/pulse')).text, 'Best play of the week');
    });

    await check('the author withdraws: gone from the page, the list and Pulse; nobody else may; not twice', async () => {
        assert.strictEqual((await api(`/${slug}/withdraw`, { method: 'POST', token: samJwt })).status, 403);
        const r = await t.get(`/submissions/${slug}/withdraw`, as(alexJwt, form({})));
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual((await row(slug)).status, 'withdrawn');
        assert.strictEqual(await pulseItem(slug), undefined);
        assert.strictEqual((await t.get(`/submissions/${slug}`)).status, 404);
        assert.ok(!(await t.get('/submissions')).text.includes('Best play of the week'));
        has((await t.get(`/submissions/${slug}`, as(alexJwt))).text, 'Withdrawn');
        assert.strictEqual((await api(`/${slug}/withdraw`, { method: 'POST', token: alexJwt })).status, 409);
        assert.strictEqual((await api(`/${slug}/review`, { method: 'POST', token: bossJwt, json: { decision: 'accept' } })).status, 409);
        // A pending one withdraws too.
        const p = await submitApi({ kind: 'idea', title: 'Second thoughts', body: 'Maybe not' });
        assert.strictEqual((await api(`/${p.slug}/withdraw`, { method: 'POST', token: alexJwt })).json().submission.status, 'withdrawn');
    });

    await check('rejected never reaches Pulse; a later rejection of an accepted one takes it out; Pulse re-checks on read', async () => {
        const a = await submitApi({ kind: 'report', title: 'Broken link on the home page', body: 'The footer link 404s' });
        const r = await api(`/${a.slug}/review`, { method: 'POST', token: bossJwt, json: { decision: 'reject', note: 'Already fixed' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().submission.status, 'rejected');
        assert.strictEqual(await pulseItem(a.slug), undefined);
        assert.strictEqual((await api(`/${a.slug}`)).status, 404);
        assert.strictEqual((await api(`/${a.slug}`, { token: alexJwt })).json().submission.review_note, 'Already fixed');

        const b = await submitApi({ kind: 'art', title: 'Fan art', url: 'https://example.com/art.png' });
        await api(`/${b.slug}/review`, { method: 'POST', token: bossJwt, json: { decision: 'accept' } });
        assert.ok(await pulseItem(b.slug));
        await api(`/${b.slug}/review`, { method: 'POST', token: bossJwt, json: { decision: 'reject' } });
        assert.strictEqual(await pulseItem(b.slug), undefined);

        const c = await submitApi({ kind: 'idea', title: 'Changed behind our back', body: 'x' });
        await api(`/${c.slug}/review`, { method: 'POST', token: bossJwt, json: { decision: 'accept' } });
        await t.db.prepare("UPDATE submissions SET status = 'rejected' WHERE slug = ?").run(c.slug);   // no hook ran
        assert.ok(await pulseItem(c.slug), 'row still there');
        assert.ok(!(await t.get('/api/v1/pulse?limit=100')).json().items.some((i) => i.source.id === c.slug), 'but never listed');
    });

    await check('identity comes from the token, never the body; services cannot submit; input is checked', async () => {
        const s = await submitApi({ kind: 'idea', title: 'Mine', body: 'x', author_subject: sam.subject_id, status: 'accepted', reviewer_subject: sam.subject_id });
        const r = await row(s.slug);
        assert.deepStrictEqual([r.author_subject, r.status, r.reviewer_subject], [alex.subject_id, 'pending', null]);
        const svc = net.signService({ cap: ['community.comment.write', 'community.paste.create'] });
        const sv = await api('', { method: 'POST', token: svc, json: { kind: 'idea', title: 'From a service', body: 'x' }, headers: { 'x-ov-subject': alex.subject_id } });
        assert.strictEqual(sv.status, 403, sv.text);
        for (const [body, code] of [
            [{ kind: 'meme', title: 'x', body: 'y' }, 'submission.invalid_kind'],
            [{ kind: 'idea', title: '', body: 'y' }, 'submission.invalid_title'],
            [{ kind: 'clip', title: 'No clip' }, 'submission.media_required'],
            [{ kind: 'art', title: 'Bad link', url: 'javascript:alert(1)' }, 'submission.invalid_url'],
            [{ kind: 'art', title: 'Bad ref', media_ref: 'med_nope' }, 'submission.invalid_media_ref'],
        ]) {
            const out = await api('', { method: 'POST', token: alexJwt, json: body });
            assert.strictEqual(out.status, 400, `${JSON.stringify(body)}: ${out.text}`);
            assert.strictEqual(out.json().code, code);
        }
        const ok = await submitApi({ kind: 'art', title: 'Stored in Media', media_ref: 'med_01J00000000000000000000000' });
        assert.strictEqual(ok.media_ref, 'med_01J00000000000000000000000');
        const bad = await t.get('/submissions', as(alexJwt, form({ kind: 'clip', title: 'No link' })));
        assert.strictEqual(bad.status, 400);
        has(bad.text, 'A clip or art submission needs a link');
        has(bad.text, 'value="No link"');
    });

    await check('a form sent from another site is refused (submit, withdraw, review)', async () => {
        const before = await count();
        const evil = { origin: 'https://evil.example' };
        const r = await t.get('/submissions', as(alexJwt, form({ kind: 'idea', title: 'Cross site', body: 'x' }, evil)));
        assert.strictEqual(r.status, 403);
        has(r.text, 'That form was sent from another site.');
        assert.strictEqual(await count(), before);
        const p = await submitApi({ kind: 'idea', title: 'Target', body: 'x' });
        assert.strictEqual((await t.get(`/submissions/${p.slug}/withdraw`, as(alexJwt, form({}, evil)))).status, 403);
        assert.strictEqual((await t.get(`/submissions/${p.slug}/review`, as(bossJwt, form({ decision: 'accept' }, evil)))).status, 403);
        assert.strictEqual((await row(p.slug)).status, 'pending');
        const same = await t.get('/submissions', as(alexJwt, form({ kind: 'idea', title: 'Same site', body: 'x' }, { origin: 'https://openvibe.community' })));
        assert.strictEqual(same.status, 303);
    });

    await t.close();
    done();
})();
