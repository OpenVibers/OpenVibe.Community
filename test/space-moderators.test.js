'use strict';
/**
 * Per-space moderators (T10 step 1, migrations/0005_space_moderators.sql): a person listed for a space moderates
 * that space — thread state, deletes, settings, categories, its moderators — and nothing anywhere else; discussion
 * staff still moderate everywhere; creating spaces and the board index stay with staff. Adding is refused for a
 * non-moderator and across a block; account deletion erases the row and a subject merge moves it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({
        appOpts: { forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } },
    });
    const net = t.network;
    const mk = (id, username, role = 'user') => {
        const u = net.addUser({ network_user_id: id, username, display_name: username });
        return { ...u, jwt: net.sign({ id, subject_id: u.subject_id, username, display_name: username, role }) };
    };
    const alex = mk(31, 'alex');              // moderates general
    const sam = mk(32, 'sam');                // nobody in particular
    const bob = mk(33, 'bob');                // writes the threads
    const carol = mk(34, 'carol');            // added by alex
    const dave = mk(35, 'dave');              // blocked alex
    const boss = mk(36, 'boss', 'global_mod');
    const call = (path, { method = 'GET', who, json } = {}) => t.get(path, {
        method, headers: json !== undefined ? { 'content-type': 'application/json' } : {}, body: json !== undefined ? JSON.stringify(json) : undefined, cookies: who ? [`ov_token=${who.jwt}`] : [],
    });
    const form = (path, who, fields) => t.get(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), cookies: [`ov_token=${who.jwt}`] });
    const thread = async (space) => {
        const r = await call(`/api/v1/spaces/${space}/threads`, { method: 'POST', who: bob, json: { title: `A thread in ${space}`, body: 'hello there' } });
        assert.strictEqual(r.status, 201, r.text);
        return r.json().thread.slug;
    };
    const mods = async (space) => (await call(`/api/v1/spaces/${space}/moderators`)).json().moderators.map((m) => m.subject);

    await check('(d) adding a moderator: refused for a non-moderator, works for staff and then for the space\'s moderator', async () => {
        let r = await call(`/api/v1/spaces/general/moderators/${alex.subject_id}`, { method: 'PUT', who: sam });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'capability.denied');
        assert.strictEqual((await call(`/api/v1/spaces/general/moderators/${sam.subject_id}`, { method: 'PUT', who: sam })).status, 403, 'nobody adds themselves');
        assert.strictEqual((await call(`/api/v1/spaces/general/moderators/${alex.subject_id}`, { method: 'PUT' })).status, 403, 'signed out');
        r = await call(`/api/v1/spaces/general/moderators/${alex.subject_id}`, { method: 'PUT', who: boss });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json().moderators.map((m) => [m.subject, m.username, m.added_by]), [[alex.subject_id, 'alex', boss.subject_id]]);
        r = await call(`/api/v1/spaces/general/moderators/${carol.subject_id}`, { method: 'PUT', who: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await call(`/api/v1/spaces/general/moderators/${carol.subject_id}`, { method: 'PUT', who: alex })).status, 200, 'idempotent');
        assert.deepStrictEqual(await mods('general'), [alex.subject_id, carol.subject_id]);
        assert.strictEqual((await call('/api/v1/spaces/general/moderators/not-a-subject', { method: 'PUT', who: alex })).status, 400);
        assert.strictEqual((await call(`/api/v1/spaces/no-such-space/moderators/${carol.subject_id}`, { method: 'PUT', who: boss })).status, 404);
        assert.strictEqual((await call(`/api/v1/spaces/showcase/moderators/${sam.subject_id}`, { method: 'PUT', who: alex })).status, 403, 'not in another space');
        assert.deepStrictEqual(await mods('showcase'), []);
    });

    await check('a person who blocked the one adding them (or was blocked by them) cannot be added', async () => {
        await t.db.prepare('INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, 1, 1, ?)').run(dave.subject_id, alex.subject_id, Date.now());
        const r = await call(`/api/v1/spaces/general/moderators/${dave.subject_id}`, { method: 'PUT', who: alex });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'community.blocked');
        assert.ok(!(await mods('general')).includes(dave.subject_id));
    });

    await check('(a) a moderator of general locks, sets the state of and deletes a thread there; can_moderate shows it', async () => {
        const slug = await thread('general');
        let r = await call(`/api/v1/spaces/general/threads/${slug}/state`, { method: 'PUT', who: alex, json: { locked: true, pinned: true } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().thread.locked, true);
        const page = (await call(`/api/v1/spaces/general/threads/${slug}`, { who: alex })).json();
        assert.strictEqual(page.viewer.can_moderate, true);
        assert.strictEqual(page.viewer.can_delete, true);
        assert.strictEqual(page.posts[0].can_edit, true);
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${slug}/posts`, { method: 'POST', who: alex, json: { body: 'moderators reply in a locked thread' } })).status, 201);
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${slug}/posts`, { method: 'POST', who: sam, json: { body: 'others do not' } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { who: alex })).json().viewer.can_moderate, true);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { who: sam })).json().viewer.can_moderate, false);
        r = await call(`/api/v1/spaces/general/threads/${slug}`, { method: 'DELETE', who: alex });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual((await call(`/api/v1/spaces/general/threads/${slug}`, { who: alex })).status, 404);
    });

    await check('(b) the same moderator gets 403 in showcase', async () => {
        const slug = await thread('showcase');
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${slug}/state`, { method: 'PUT', who: alex, json: { locked: true } })).status, 403);
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${slug}`, { method: 'DELETE', who: alex })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/showcase/settings', { method: 'PUT', who: alex, json: { name: 'Mine now' } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/showcase/categories/clips', { method: 'PUT', who: alex, json: { name: 'Clips' } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/showcase/members-only', { method: 'PUT', who: alex, json: { owner: alex.subject_id } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/showcase/threads', { who: alex })).json().viewer.can_moderate, false);
        const page = (await call(`/api/v1/spaces/showcase/threads/${slug}`, { who: alex })).json();
        assert.strictEqual(page.viewer.can_moderate, false);
        assert.strictEqual(page.viewer.can_delete, false);
        assert.strictEqual(page.posts[0].can_edit, false);
        assert.strictEqual((await form(`/s/showcase/t/${slug}/state`, alex, { locked: '1' })).status, 403, 'the no-JS form too');
        assert.strictEqual((await call(`/api/v1/spaces/showcase/threads/${slug}`, { who: sam })).json().thread.locked, false);
    });

    await check('(c) a global moderator still passes in both spaces', async () => {
        for (const space of ['general', 'showcase']) {
            const slug = await thread(space);
            assert.strictEqual((await call(`/api/v1/spaces/${space}/threads/${slug}/state`, { method: 'PUT', who: boss, json: { locked: true } })).status, 200, space);
            assert.strictEqual((await call(`/api/v1/spaces/${space}/threads/${slug}`, { method: 'DELETE', who: boss })).status, 200, space);
        }
    });

    await check('settings and categories of their own space; never its place on the board index', async () => {
        let r = await call('/api/v1/spaces/general/settings', { method: 'PUT', who: alex, json: { description: 'Run by its moderators' } });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().space.description, 'Run by its moderators');
        assert.strictEqual((await call('/api/v1/spaces/general/settings', { method: 'PUT', who: alex, json: { group: null } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/general/settings', { method: 'PUT', who: alex, json: { parent: 'showcase' } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/general/categories/help', { method: 'PUT', who: alex, json: { name: 'Help' } })).status, 200);
        assert.strictEqual((await call('/api/v1/spaces/general/categories/help', { method: 'DELETE', who: alex })).status, 200);
        const before = (await call('/api/v1/spaces/general')).json().space.group;
        r = await form('/s/general/settings', alex, { name: 'General', description: 'From the form', style: 'forum', reactions: '1', group: '' });
        assert.strictEqual(r.status, 303, r.text);
        assert.deepStrictEqual((await call('/api/v1/spaces/general')).json().space.group, before, 'the form leaves the group alone');
    });

    await check('(e) a space moderator cannot create a space or change the board index', async () => {
        assert.strictEqual((await call('/api/v1/spaces', { method: 'POST', who: alex, json: { slug: 'alex-space', name: 'Alex space' } })).status, 403);
        assert.strictEqual((await form('/s/new-space', alex, { slug: 'alex-space', name: 'Alex space' })).status, 403);
        assert.strictEqual((await call('/api/v1/space-groups/alex-group', { method: 'PUT', who: alex, json: { name: 'Alex group' } })).status, 403);
        assert.strictEqual((await call('/api/v1/spaces/alex-space')).status, 404);
    });

    await check('no-JS forms add and remove; a moderator removes another (or themselves)', async () => {
        let r = await form('/s/general/moderators', alex, { subject: sam.subject_id });
        assert.strictEqual(r.status, 303, r.text);
        assert.ok((await mods('general')).includes(sam.subject_id));
        assert.strictEqual((await form('/s/showcase/moderators', alex, { subject: sam.subject_id })).status, 403);
        r = await form('/s/general/moderators/remove', carol, { subject: sam.subject_id });
        assert.strictEqual(r.status, 303, r.text);
        assert.strictEqual((await call(`/api/v1/spaces/general/moderators/${sam.subject_id}`, { method: 'DELETE', who: sam })).status, 403, 'no longer one');
        r = await call(`/api/v1/spaces/general/moderators/${carol.subject_id}`, { method: 'DELETE', who: carol });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(await mods('general'), [alex.subject_id]);
    });

    await check('(f) account deletion erases the row; a subject merge moves it', async () => {
        const accountData = require('../server/identity/account-data');
        const merge = require('../server/identity/subject-merge');
        const ids = async (subject) => (await t.db.prepare('SELECT space_id FROM space_moderators WHERE subject_id = ? ORDER BY space_id').all(subject)).map((r) => Number(r.space_id));
        await call(`/api/v1/spaces/showcase/moderators/${carol.subject_id}`, { method: 'PUT', who: boss });
        await call(`/api/v1/spaces/general/moderators/${carol.subject_id}`, { method: 'PUT', who: boss });
        await call(`/api/v1/spaces/showcase/moderators/${bob.subject_id}`, { method: 'PUT', who: boss });
        // carol folds into bob: general moves over, showcase (both had it) stays bob's alone.
        await merge.apply(t.db, { from: carol.subject_id, into: bob.subject_id, merge_id: 'mrg_01JAB2C3D4E5F6G7H8J9K0MNP4' }, { log: { log() {} } });
        assert.deepStrictEqual(await ids(carol.subject_id), []);
        assert.deepStrictEqual(await ids(bob.subject_id), [1, 3]);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { who: bob })).json().viewer.can_moderate, true);
        // alex's account is deleted: the row goes, and the moderators alex added stay without them.
        await call(`/api/v1/spaces/general/moderators/${sam.subject_id}`, { method: 'PUT', who: alex });
        const out = await accountData.erase(t.db, [alex.subject_id]);
        assert.strictEqual(out.erased.space_moderators, 1);
        assert.deepStrictEqual(await ids(alex.subject_id), []);
        assert.strictEqual((await t.db.prepare('SELECT added_by FROM space_moderators WHERE subject_id = ? AND space_id = 1').get(sam.subject_id)).added_by, null);
        assert.strictEqual((await call('/api/v1/spaces/general/threads', { who: alex })).json().viewer.can_moderate, false);
    });

    await t.close();
    done();
})();
