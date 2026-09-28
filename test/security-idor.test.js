'use strict';
/**
 * IDOR: nobody acts on someone else's things by swapping ids (roadmap WS-R task 5).
 *
 * alex owns a public paste, a private one, a screenshot, comments, a thread with a reply, a typed comment,
 * an uploaded image and a space (as its creator; spaces have no per-space moderators, so a space's owner
 * is what "moderator of X" means here: cora owns another). sam tries each of alex's ids as himself, and so
 * do first-party services forwarding for him (svc:live, svc:tools, each with the write grants they hold)
 * and a developer app acting for him: editing, deleting, changing visibility, re-screenshotting
 * (censor), the AI write-back, bulk actions, reading edit history, managing comments (also through a
 * paste he owns), gating, pinning/locking, categories and statuses, space settings and chat rooms,
 * claiming alex's uploaded image, and a service retracting or publishing another service's Pulse items.
 * Every refusal is a 401/403/404 (claiming an upload: attachments.invalid, 400, as for an id never uploaded)
 * and leaves the database exactly as it was (21 content tables compared); positive controls show each
 * route works for the owner (or staff), so a broken route cannot pass for a refusal. Likes and votes are
 * always the caller's own; an app naming alex is refused.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');

const TABLES = ['pastes', 'paste_versions', 'paste_comments', 'paste_likes', 'spaces', 'space_groups', 'categories', 'threads', 'posts', 'post_versions',
    'post_reactions', 'post_pastes', 'thread_votes', 'attachments', 'comment_threads', 'comments', 'comment_votes', 'space_chat_rooms', 'relay_mappings', 'relay_deliveries', 'pulse_items'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PASTE_CAPS = ['community.paste.create', 'community.paste.write'];
const FORUM_CAPS = ['community.post.create', 'community.comment.write'];

(async () => {
    const chatCalls = [];
    const t = await boot({
        authority: 'community',
        pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 },
        appOpts: {
            startRelay: false,
            forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, votes: { perMinute: 1000 }, threadsPerDay: 1000 },
            commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } },
            // OpenVibe.Chat says yes to whatever it is asked: only Community's own check stands between a person and a space.
            chatRooms: {
                parseRoomRef: (r) => (/^[a-z0-9-]{3,32}$/.test(String(r || '')) ? String(r) : null),
                roomUrl: (s) => `https://openvibe.chat/r/${s}`,
                attach: async ({ room }) => { chatCalls.push(['attach', room]); return { room: { id: `room_${room}`, slug: room, name: room, kind: 'group', visibility: 'public' } }; },
                detach: async ({ room }) => { chatCalls.push(['detach', room]); return 'detached'; },
            },
        },
    });
    const net = t.network;
    const mk = (id, username, role = 'user') => {
        const u = net.addUser({ network_user_id: id, username, display_name: username });
        return { ...u, jwt: net.sign({ id, subject_id: u.subject_id, username, display_name: username, role }) };
    };
    const alex = mk(41, 'alex'), sam = mk(42, 'sam'), cora = mk(43, 'cora'), boss = mk(44, 'boss', 'global_mod');
    const PROJECT = 'prj_01J8ZQ4Y7N3M2K1H0G9F8E7D6C';
    const as = {
        alex: { who: alex }, sam: { who: sam }, cora: { who: cora }, boss: { who: boss },
        'svc:live for sam': { token: net.signService({ sub: 'svc:live', cap: [...PASTE_CAPS, ...FORUM_CAPS] }), headers: { 'x-ov-subject': sam.subject_id } },
        'svc:tools for sam': { token: net.signService({ sub: 'svc:tools', cap: [...PASTE_CAPS, ...FORUM_CAPS] }), headers: { 'x-ov-subject': sam.subject_id } },
        'an app for sam': { token: net.signService({ sub: 'app:app_01HZX3K5V7Q9M2N4P6R8T0W2Y4', actorType: 'app', cap: [...PASTE_CAPS, ...FORUM_CAPS], extra: { env: 'production', project_id: PROJECT, ns: [PROJECT], on_behalf_of: sam.subject_id } }) },
        'svc:live as itself': { token: net.signService({ sub: 'svc:live', cap: [...PASTE_CAPS, ...FORUM_CAPS] }) },
    };
    const SAMS = ['sam', 'svc:live for sam', 'svc:tools for sam', 'an app for sam'];

    let ipN = 0;
    async function send(method, path, { who, token, headers = {}, json, form, body } = {}) {
        const h = { 'x-forwarded-for': `198.51.100.${(ipN++ % 250) + 1}`, ...headers };
        if (who) h.cookie = `ov_token=${who.jwt}`;
        if (token) h.authorization = `Bearer ${token}`;
        let payload = body;
        if (json !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
        if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
        const res = await fetch(t.base + path, { method, headers: h, body: payload, redirect: 'manual' });
        return { status: res.status, text: await res.text(), json() { return JSON.parse(this.text); } };
    }
    const snapshot = async () => (await Promise.all(TABLES.map(async (tb) => `${tb}:${JSON.stringify(await t.db.prepare(`SELECT * FROM ${tb} ORDER BY ${tb}::text`).all())}`))).join('\n');
    const ok = (r, what) => { assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 300)}`); return r.status === 204 ? null : r.json(); };
    const imageForm = (field, extra = {}) => { const f = new FormData(); for (const [k, v] of Object.entries(extra)) f.append(k, v); f.append(field, new Blob([PNG], { type: 'image/png' }), 'x.png'); return f; };

    /** Each persona's attempt is refused (401/403/404, or the route's documented refusal) and changes nothing. */
    async function refused(label, method, path, personas, opts = {}, statuses = [401, 403, 404]) {
        for (const name of personas) {
            const before = await snapshot();
            const o = typeof opts === 'function' ? opts() : opts;
            const r = await send(method, path, { ...as[name], ...o, headers: { ...(as[name].headers || {}), ...(o.headers || {}) } });
            assert.ok(statuses.includes(r.status), `${label} as ${name}: ${r.status} ${r.text.slice(0, 200)}`);
            assert.strictEqual(await snapshot(), before, `${label} as ${name}: refused (${r.status}) but the database changed`);
        }
    }
    /** The owner (or staff) may: the route works, and it changes the database. */
    async function allowed(label, method, path, name, opts = {}) {
        const before = await snapshot();
        const r = await send(method, path, { ...as[name], ...opts, headers: { ...(as[name].headers || {}), ...(opts.headers || {}) } });
        const out = ok(r, `${label} as ${name}`);
        assert.notStrictEqual(await snapshot(), before, `${label} as ${name}: answered ${r.status} but nothing changed`);
        return out;
    }

    // ── alex's things ──
    const pub = ok(await send('POST', '/api/pastes', { who: alex, json: { title: 'alex public', content: 'alex words' } }), 'paste');
    const priv = ok(await send('POST', '/api/pastes', { who: alex, json: { title: 'alex private', content: 'alex secret', visibility: 'private' } }), 'private paste');
    const shot = ok(await send('POST', '/api/pastes/screenshot', { who: alex, body: imageForm('screenshot', { title: 'alex shot' }) }), 'screenshot');
    const alexComment = ok(await send('POST', `/api/pastes/${pub.slug}/comments`, { who: alex, json: { message: 'alex on his paste' } }), 'paste comment').comment;
    const samPaste = ok(await send('POST', '/api/pastes', { who: sam, json: { title: 'sam paste', content: 'sam words' } }), 'sam paste');
    const alexOnSam = ok(await send('POST', `/api/pastes/${samPaste.slug}/comments`, { who: alex, json: { message: 'alex on sam paste' } }), 'comment on sam paste').comment;
    const thread = ok(await send('POST', '/api/v1/spaces/general/threads', { who: alex, json: { title: 'alex thread', body: 'alex opening' } }), 'thread');
    const reply = ok(await send('POST', `/api/v1/spaces/general/threads/${thread.thread.slug}/posts`, { who: alex, json: { body: 'alex reply' } }), 'reply').post;
    const cthread = ok(await send('POST', '/api/v1/comments/threads/resolve', { who: alex, json: { ref: { service: 'community', type: 'paste', id: pub.slug } } }), 'comment thread').thread;
    const typed = ok(await send('POST', `/api/v1/comments/threads/${cthread.id}/comments`, { who: alex, json: { message: 'alex typed comment' } }), 'typed comment').comment;
    const upload = ok(await send('POST', '/api/v1/spaces/general/attachments', { who: alex, body: imageForm('file') }), 'alex upload').attachment;
    await t.db.prepare("UPDATE spaces SET created_by = ? WHERE slug = 'general'").run(alex.subject_id);
    await t.db.prepare("UPDATE spaces SET created_by = ? WHERE slug = 'showcase'").run(cora.subject_id);
    ok(await send('PUT', '/api/v1/spaces/general/chat-room', { who: alex, json: { room: 'alex-room' } }), 'alex attaches a room to his space');
    const liveItem = ok(await send('POST', '/api/v1/pulse/items', { token: net.signService({ sub: 'svc:live', cap: ['community.pulse.write'] }), json: { ref: { service: 'live', type: 'stream', id: '9' }, title: 'alex is live', url: 'https://openvibe.live/@alex' } }), 'live pulse item');
    assert.ok(liveItem.item);

    await check('pastes: sam (and services and an app acting for him) cannot edit, hide, delete, re-screenshot, annotate, bulk-change or read the history of alex\'s pastes', async () => {
        const P = `/api/pastes/${pub.slug}`;
        await refused('edit the title', 'PUT', P, [...SAMS, 'svc:live as itself'], { json: { title: 'defaced' } });
        await refused('edit the content', 'PUT', P, SAMS, { json: { content: 'defaced' } });
        await refused('make it private', 'PUT', P, SAMS, { json: { visibility: 'private' } });
        await refused('pin it', 'PUT', P, SAMS, { json: { pinned: true } });
        await refused('delete it', 'DELETE', P, [...SAMS, 'svc:live as itself']);
        await refused('read its history', 'GET', `${P}/versions`, [...SAMS, 'svc:live as itself']);
        await refused('private: edit', 'PUT', `/api/pastes/${priv.slug}`, SAMS, { json: { title: 'defaced' } });
        await refused('private: delete', 'DELETE', `/api/pastes/${priv.slug}`, SAMS);
        await refused('private: read', 'GET', `/api/pastes/${priv.slug}`, SAMS);
        await refused('private: history', 'GET', `/api/pastes/${priv.slug}/versions`, SAMS);
        await refused('re-screenshot (censor) it', 'POST', `/api/pastes/${shot.slug}/censor`, SAMS, () => ({ body: imageForm('screenshot') }));
        await refused('write the AI summary', 'POST', `/api/pastes/${shot.slug}/ai`, SAMS, { json: { ai_summary: 'lies' } });
        await refused('bulk delete', 'POST', '/api/pastes/bulk', SAMS, { json: { slugs: [pub.slug, priv.slug], action: 'delete' } });
        await refused('bulk make private', 'POST', '/api/pastes/bulk', SAMS, { json: { slugs: [pub.slug], action: 'private' } });
        await refused('delete all forks', 'DELETE', '/api/pastes/admin/forks', SAMS);
        await refused('X-OV-Staff without the moderation grant', 'DELETE', P, ['svc:live for sam'], { headers: { 'x-ov-staff': '1' } });
        // Positive controls.
        await allowed('the owner edits', 'PUT', P, 'alex', { json: { title: 'alex public, edited' } });
        assert.strictEqual(ok(await send('GET', `${P}/versions`, as.alex), 'history').versions.length >= 1, true);
        await allowed('a service for the owner edits', 'PUT', P, 'svc:live for sam', { headers: { 'x-ov-subject': alex.subject_id }, json: { title: 'alex public, via Live' } });
        await allowed('staff pin it', 'PUT', P, 'boss', { json: { pinned: true } });
        await allowed('staff re-screenshot it', 'POST', `/api/pastes/${shot.slug}/censor`, 'boss', { body: imageForm('screenshot') });
    });

    await check('paste comments: sam cannot delete alex\'s comments, not even by naming them under a paste he owns; the paste\'s owner moderates only his own paste', async () => {
        await refused('delete alex\'s comment on alex\'s paste', 'DELETE', `/api/pastes/${pub.slug}/comments/${alexComment.id}`, SAMS);
        await refused('delete it through sam\'s own paste', 'DELETE', `/api/pastes/${samPaste.slug}/comments/${alexComment.id}`, SAMS);
        await refused('delete it through a private paste', 'DELETE', `/api/pastes/${priv.slug}/comments/${alexComment.id}`, SAMS);
        await allowed('sam removes a comment on his own paste', 'DELETE', `/api/pastes/${samPaste.slug}/comments/${alexOnSam.id}`, 'sam');
        await allowed('alex removes his own', 'DELETE', `/api/pastes/${pub.slug}/comments/${alexComment.id}`, 'alex');
    });

    await check('likes and votes are always the caller\'s own; an app cannot name alex', async () => {
        await allowed('sam likes alex\'s paste', 'POST', `/api/pastes/${pub.slug}/like`, 'sam');
        const likers = (await t.db.prepare('SELECT subject_id FROM paste_likes pl JOIN pastes p ON p.id = pl.paste_id WHERE p.slug = ?').all(pub.slug)).map((r) => r.subject_id);
        assert.deepStrictEqual(likers, [sam.subject_id]);
        await refused('an app for sam likes as alex', 'POST', `/api/pastes/${pub.slug}/like`, ['an app for sam'], { headers: { 'x-ov-subject': alex.subject_id } });
        await refused('an app for sam votes as alex', 'POST', `/api/v1/spaces/general/threads/${thread.thread.slug}/votes`, ['an app for sam'], { headers: { 'x-ov-subject': alex.subject_id }, json: { value: 1 } });
    });

    await check('forum: sam cannot edit, delete, read the history of, gate, pin/lock, re-categorise or re-status alex\'s thread and posts (API and forms); ids from another space are not found', async () => {
        const T = `/api/v1/spaces/general/threads/${thread.thread.slug}`;
        await refused('edit the reply', 'PUT', `/api/v1/posts/${reply.id}`, SAMS, { json: { body: 'defaced' } });
        await refused('edit the opening post', 'PUT', `/api/v1/posts/${thread.post.id}`, SAMS, { json: { body: 'defaced' } });
        await refused('delete the reply', 'DELETE', `/api/v1/posts/${reply.id}`, SAMS);
        await refused('read the reply\'s history', 'GET', `/api/v1/posts/${reply.id}/versions`, SAMS);
        await refused('delete the thread', 'DELETE', T, SAMS);
        await refused('re-categorise it', 'PUT', `${T}/category`, SAMS, { json: { category: null } });
        await refused('change its status', 'PUT', `${T}/status`, SAMS, { json: { status: 'done' } });
        await refused('pin and lock it', 'PUT', `${T}/state`, SAMS, { json: { pinned: true, locked: true } });
        await refused('gate it to sam\'s members', 'PUT', `${T}/members-only`, SAMS, { json: { owner: true } });
        await refused('gate it to alex\'s members', 'PUT', `${T}/members-only`, SAMS, { json: { owner: alex.subject_id } });
        for (const [suffix, form] of [['delete', {}], ['state', { pinned: '1', locked: '1' }], ['members-only', { on: '1' }], ['category', { category: '' }], ['status', { status: 'done' }]]) {
            await refused(`form ${suffix}`, 'POST', `/s/general/t/${thread.thread.slug}/${suffix}`, ['sam'], { form });
        }
        // The right thread slug under the wrong space: not found, even for its author.
        await refused('delete it under another space', 'DELETE', `/api/v1/spaces/feedback/threads/${thread.thread.slug}`, ['alex', 'sam']);
        await refused('re-categorise it under another space', 'PUT', `/api/v1/spaces/showcase/threads/${thread.thread.slug}/category`, ['alex'], { json: { category: null } });
        // Positive controls.
        await allowed('the author edits', 'PUT', `/api/v1/posts/${reply.id}`, 'alex', { json: { body: 'alex reply, edited' } });
        assert.strictEqual(ok(await send('GET', `/api/v1/posts/${reply.id}/versions`, as.alex), 'history').versions.length >= 2, true);
        await allowed('a service for the author edits', 'PUT', `/api/v1/posts/${reply.id}`, 'svc:live for sam', { headers: { 'x-ov-subject': alex.subject_id }, json: { body: 'alex reply, via Live' } });
        await allowed('a moderator pins it', 'PUT', `${T}/state`, 'boss', { json: { pinned: true } });
        await allowed('the author gates it to his members', 'PUT', `${T}/members-only`, 'alex', { json: { owner: true } });
        await allowed('and opens it again', 'PUT', `${T}/members-only`, 'alex', { json: { owner: null } });
    });

    await check('uploads: sam cannot put alex\'s uploaded image on his own post', async () => {
        // Refused as attachments.invalid (400), the same answer as an id that was never uploaded.
        await refused('claim alex\'s upload in a thread', 'POST', '/api/v1/spaces/general/threads', ['sam', 'svc:live for sam'], { json: { title: 'mine now', body: 'look', attachments: [upload.media_id] } }, [400]);
        await refused('claim it in a reply', 'POST', `/api/v1/spaces/general/threads/${thread.thread.slug}/posts`, ['sam'], { json: { body: 'look', attachments: [upload.media_id] } }, [400]);
        const r = await allowed('alex attaches his own', 'POST', `/api/v1/spaces/general/threads/${thread.thread.slug}/posts`, 'alex', { json: { body: 'my picture', attachments: [upload.media_id] } });
        assert.strictEqual(r.post.attachments[0].media_id, upload.media_id);
    });

    await check('typed comments: sam (and services for him) cannot edit or delete alex\'s comment, nor hide his thread', async () => {
        await refused('edit it', 'PATCH', `/api/v1/comments/${typed.id}`, SAMS, { json: { message: 'defaced' } });
        await refused('delete it', 'DELETE', `/api/v1/comments/${typed.id}`, SAMS);
        await refused('hide the thread', 'PUT', `/api/v1/comments/threads/${cthread.id}/visibility`, ['sam', 'an app for sam'], { json: { visibility: 'hidden' } });
        await refused('read one comment with its thread by id (services only)', 'GET', `/api/v1/comments/${typed.id}`, ['sam']);
        await allowed('alex edits his own', 'PATCH', `/api/v1/comments/${typed.id}`, 'alex', { json: { message: 'alex typed comment, edited' } });
        await allowed('a moderator hides the thread', 'PUT', `/api/v1/comments/threads/${cthread.id}/visibility`, 'boss', { json: { visibility: 'hidden' } });
    });

    await check('spaces: the owner of one space cannot manage another\'s chat room; sam cannot change space settings, categories, gating or the board', async () => {
        await refused('cora attaches a room to alex\'s space', 'PUT', '/api/v1/spaces/general/chat-room', ['cora', 'sam'], { json: { room: 'cora-room' } });
        await refused('cora detaches alex\'s room', 'DELETE', '/api/v1/spaces/general/chat-room', ['cora', 'sam']);
        await refused('cora detaches it by form', 'POST', '/s/general/chat-room/detach', ['cora'], { form: {} });
        await refused('cora attaches by form', 'POST', '/s/general/chat-room', ['cora'], { form: { room: 'cora-room' } });
        assert.ok(!chatCalls.some(([, room]) => room === 'cora-room'), 'Chat was never asked for cora\'s room on alex\'s space');
        await refused('space settings', 'PUT', '/api/v1/spaces/general/settings', [...SAMS, 'cora'], { json: { name: 'Taken' } });
        await refused('space settings by form', 'POST', '/s/general/settings', ['sam', 'alex'], { form: { name: 'Taken' } });
        await refused('a category', 'PUT', '/api/v1/spaces/general/categories/taken', [...SAMS, 'alex'], { json: { name: 'Taken' } });
        await refused('gate the space', 'PUT', '/api/v1/spaces/general/members-only', [...SAMS, 'alex'], { json: { owner: sam.subject_id } });
        await refused('a board group', 'PUT', '/api/v1/space-groups/taken', SAMS, { json: { name: 'Taken' } });
        await refused('create a space', 'POST', '/api/v1/spaces', SAMS, { json: { slug: 'taken', name: 'Taken' } });
        await refused('relay mappings', 'POST', '/api/v1/relay/mappings', ['sam', 'alex'], { json: { space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_X' } });
        await allowed('cora attaches a room to her own space', 'PUT', '/api/v1/spaces/showcase/chat-room', 'cora', { json: { room: 'cora-room' } });
        await allowed('alex detaches his own', 'DELETE', '/api/v1/spaces/general/chat-room', 'alex');
        await allowed('a moderator changes settings', 'PUT', '/api/v1/spaces/general/settings', 'boss', { json: { description: 'Changed by staff' } });
    });

    await check('Pulse: one service cannot publish or retract another service\'s items', async () => {
        const tools = { token: net.signService({ sub: 'svc:tools', cap: ['community.pulse.write'] }) };
        as['svc:tools (pulse)'] = tools;
        await refused('retract Live\'s item', 'DELETE', '/api/v1/pulse/items/live/stream/9', ['svc:tools (pulse)', 'sam', 'svc:live for sam']);
        await refused('publish as Live', 'POST', '/api/v1/pulse/items', ['svc:tools (pulse)'], { json: { ref: { service: 'live', type: 'stream', id: '10' }, title: 'fake', url: 'https://openvibe.live/@x' } });
        as['svc:live (pulse)'] = { token: net.signService({ sub: 'svc:live', cap: ['community.pulse.write'] }) };
        await allowed('Live retracts its own', 'DELETE', '/api/v1/pulse/items/live/stream/9', 'svc:live (pulse)');
    });

    await t.close();
    done();
})();
