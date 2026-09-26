'use strict';
/**
 * A space's chat room (roadmap WS-I task 4; server/chat-rooms.js, forum/service.js attachChatRoom):
 * the space's owner (its creator, or the creator whose members' space it is) or staff attach a room on
 * OpenVibe.Chat; Community asks Chat with the person's own token and Chat answers whether they manage the
 * room. Attaching again is a no-op, another room replaces it, detach is idempotent; others, services and
 * signed-out visitors cannot attach; Chat's refusals (not the owner, a private room, Chat down) come back
 * as problems and as notices on the page; the space page links the room. A stub Chat stands in for
 * OpenVibe.Chat's POST/DELETE /api/chat/rooms/:slug/attachments.
 */
const assert = require('assert');
const http = require('http');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

/** Stub Chat: rooms with owners (by Network subject), private rooms with members, attachments. */
function startStubChat() {
    const rooms = new Map();
    const attachments = new Map();   // `${room}|${space}` → attached_by subject
    const calls = [];
    const state = { down: false };
    const subjectOf = (auth) => {
        const tok = String(auth || '').replace(/^Bearer /, '');
        try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).subject_id || null; } catch { return null; }
    };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (state.down) { req.socket.destroy(); return; }
            const send = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
            const who = subjectOf(req.headers.authorization);
            let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* */ }
            calls.push({ method: req.method, url: req.url, who, auth: req.headers.authorization || null, body });
            let m = /^\/api\/chat\/rooms\/([^/]+)\/attachments$/.exec(req.url);
            if (m && req.method === 'POST') {
                const room = rooms.get(m[1]);
                if (!who) return send(401, { error: 'Authentication required' });
                if (!room || (room.visibility === 'private' && !room.members.includes(who))) return send(404, { error: 'No such room', code: 'rooms.not_found' });
                if (room.owner !== who) return send(403, { error: 'Only the room\'s owner attaches it elsewhere', code: 'rooms.not_owner' });
                const key = `${room.slug}|${body.resource}`;
                const created = !attachments.has(key);
                if (created) attachments.set(key, who);
                return send(created ? 201 : 200, { attachment: { service: body.service, resource: body.resource, title: body.title }, created, room: { id: room.id, slug: room.slug, name: room.name, kind: room.kind, visibility: room.visibility } });
            }
            m = /^\/api\/chat\/rooms\/([^/]+)\/attachments\/community\/([^/]+)$/.exec(req.url);
            if (m && req.method === 'DELETE') {
                const room = rooms.get(m[1]);
                const key = `${m[1]}|${m[2]}`;
                if (!room) return send(404, { error: 'No such room' });
                if (!attachments.has(key)) return send(200, { ok: true, removed: false });
                if (room.owner !== who && attachments.get(key) !== who) return send(403, { error: 'no' });
                attachments.delete(key);
                return send(200, { ok: true, removed: true });
            }
            send(404, { error: 'Not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, rooms, attachments, calls, state,
        addRoom: (slug, o) => rooms.set(slug, { id: rooms.size + 1, slug, name: slug, kind: 'community', visibility: 'public', members: [], ...o }),
        close: () => new Promise((r) => server.close(r)),
    })));
}

(async () => {
    const chat = await startStubChat();
    process.env.OV_CHAT_INTERNAL_URL = chat.url;
    process.env.OV_CHAT_URL = 'https://openvibe.chat';
    const t = await boot({ authority: 'community' });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const bossSubject = ids.newId('user');
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const bossJwt = net.sign({ id: 1, subject_id: bossSubject, username: 'boss', display_name: 'Boss', role: 'admin' });
    // Alex owns the Showcase space (its creator) and the rooms night-owls and secret; Sam owns sams-room; Boss (staff) owns staff-room.
    t.db.prepare("UPDATE spaces SET created_by = ? WHERE slug = 'showcase'").run(alex.subject_id);
    t.db.prepare("UPDATE spaces SET members_only_owner = ? WHERE slug = 'off-topic'").run(sam.subject_id);
    chat.addRoom('night-owls', { name: 'Night Owls', owner: alex.subject_id });
    chat.addRoom('secret', { name: 'Secret', owner: sam.subject_id, visibility: 'private', members: [sam.subject_id] });
    chat.addRoom('stage', { name: 'Stage', kind: 'call', owner: sam.subject_id });
    chat.addRoom('sams-room', { name: 'Sam\'s Room', owner: sam.subject_id });
    chat.addRoom('staff-room', { name: 'Staff Room', owner: bossSubject });
    const api = (method, path, jwt, body) => t.get(`/api/v1/spaces${path}`, { method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const form = (jwt, path, fields, origin = 'https://openvibe.community') => t.get(path, { method: 'POST', cookies: [`ov_token=${jwt}`], headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields).toString() });
    const rows = () => t.db.prepare('SELECT * FROM space_chat_rooms ORDER BY space_id').all();

    await check('only the space\'s owner or staff attach, and only as themselves', async () => {
        const before = chat.calls.length;
        assert.strictEqual((await api('PUT', '/showcase/chat-room', null, { room: 'night-owls' })).status, 401);
        let r = await api('PUT', '/showcase/chat-room', samJwt, { room: 'sams-room' });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'capability.denied'], 'not the space\'s owner');
        const svc = net.signService({ sub: 'svc:live', cap: ['community.comment.moderate', 'community.post.create'] });
        r = await api('PUT', '/showcase/chat-room', svc, { room: 'night-owls' });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'chat_room.person_only'], 'a service has no person\'s token to show Chat');
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: '../../admin' });
        assert.deepStrictEqual([r.status, r.json().code], [400, 'chat_room.invalid']);
        assert.strictEqual(chat.calls.length, before, 'Chat was not asked for any of these');
        assert.deepStrictEqual(rows(), []);
    });

    await check('the owner attaches by link; Chat is asked with their own token; again is a no-op', async () => {
        let r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'https://openvibe.chat/r/night-owls' });
        assert.strictEqual(r.status, 201, r.text);
        assert.deepStrictEqual(r.json().chat_room, { slug: 'night-owls', name: 'Night Owls', kind: 'community', visibility: 'public', url: 'https://openvibe.chat/r/night-owls', attached_at: r.json().chat_room.attached_at });
        const call = chat.calls[chat.calls.length - 1];
        assert.deepStrictEqual([call.method, call.url, call.auth, call.body], ['POST', '/api/chat/rooms/night-owls/attachments', `Bearer ${alexJwt}`, { service: 'community', resource: 'showcase', title: 'Showcase' }]);
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'night-owls' });
        assert.deepStrictEqual([r.status, r.json().created], [200, false]);
        assert.strictEqual(rows().length, 1);
        assert.strictEqual(rows()[0].attached_by, alex.subject_id);
        assert.strictEqual(chat.attachments.size, 1);
        assert.strictEqual((await api('GET', '/showcase')).json().space.chat_room.slug, 'night-owls', 'the space says which room');
    });

    await check('Chat\'s refusals: not the room\'s owner, a private room, Chat down; nothing changes', async () => {
        let r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'stage' });
        assert.deepStrictEqual([r.status, r.json().code], [403, 'chat_room.not_owner']);
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'secret' });
        assert.deepStrictEqual([r.status, r.json().code], [404, 'chat_room.not_found'], 'a private room is no more than a missing one');
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'no-such-room' });
        assert.strictEqual(r.json().code, 'chat_room.not_found');
        chat.state.down = true;
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'night-owls' });
        assert.deepStrictEqual([r.status, r.json().code], [503, 'chat_room.unavailable']);
        const f = await form(alexJwt, '/s/showcase/chat-room', { room: 'night-owls' });
        assert.strictEqual(f.status, 303);
        assert.match(f.headers.get('location'), /^\/s\/showcase\?chat_error=.*#chat-room$/);
        const page = await t.get(f.headers.get('location').replace(/#.*$/, ''), { cookies: [`ov_token=${alexJwt}`] });
        assert.match(page.text, /<p class="alert alert-error" role="alert">OpenVibe.Chat did not answer/);
        chat.state.down = false;
        assert.strictEqual(rows()[0].room_slug, 'night-owls');
    });

    await check('the space page links the room; its owner gets the forms; others only the link', async () => {
        let page = await t.get('/s/showcase');
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /<section class="chat-room" id="chat-room"/);
        assert.match(page.text, /<a class="btn" href="https:\/\/openvibe\.chat\/r\/night-owls" rel="noopener">.*Night Owls<\/a>/);
        assert.ok(!page.text.includes('action="/s/showcase/chat-room"'), 'no forms for a visitor');
        page = await t.get('/s/showcase', { cookies: [`ov_token=${samJwt}`] });
        assert.ok(!page.text.includes('action="/s/showcase/chat-room"'), 'nor for another person');
        page = await t.get('/s/showcase', { cookies: [`ov_token=${alexJwt}`] });
        assert.ok(page.text.includes('action="/s/showcase/chat-room"') && page.text.includes('action="/s/showcase/chat-room/detach"'));
        page = await t.get('/s/general');
        assert.ok(!page.text.includes('id="chat-room"'), 'a space without a room shows nothing');
        page = await t.get('/s/general', { cookies: [`ov_token=${bossJwt}`] });
        assert.match(page.text, /Attach a chat room/, 'staff may attach one anywhere');
        // Forum-style spaces show it too.
        await api('PUT', '/general/chat-room', bossJwt, { room: 'staff-room' });
        assert.match((await t.get('/s/general')).text, /href="https:\/\/openvibe\.chat\/r\/staff-room"/);
        assert.strictEqual((await form(alexJwt, '/s/showcase/chat-room', { room: 'night-owls' }, 'https://evil.example')).status, 403, 'forms from elsewhere are refused');
    });

    await check('replace, then detach: idempotent, and Chat is told when the person may remove its side', async () => {
        // Staff replace the Showcase room with their own; Chat is told the space let go of night-owls (best effort).
        let r = await api('PUT', '/showcase/chat-room', bossJwt, { room: 'staff-room' });
        assert.deepStrictEqual([r.status, r.json().created, r.json().chat_room.slug], [201, true, 'staff-room']);
        assert.ok(chat.calls.some((c) => c.method === 'DELETE' && c.url === '/api/chat/rooms/night-owls/attachments/community/showcase'));
        assert.strictEqual(chat.attachments.has('night-owls|showcase'), true, 'Chat keeps the old side when the caller may not remove it');
        assert.strictEqual(rows().find((x) => x.room_slug === 'staff-room' && x.attached_by === bossSubject) !== undefined, true);
        // The owner puts theirs back and detaches it without JavaScript: both sides go.
        r = await api('PUT', '/showcase/chat-room', alexJwt, { room: 'night-owls' });
        assert.strictEqual(r.status, 201);
        const f = await form(alexJwt, '/s/showcase/chat-room/detach', {});
        assert.deepStrictEqual([f.status, f.headers.get('location')], [303, '/s/showcase#chat-room']);
        assert.ok(!rows().some((x) => x.room_slug === 'night-owls'));
        assert.strictEqual(chat.attachments.has('night-owls|showcase'), false, 'Chat\'s side went too');
        r = await api('DELETE', '/showcase/chat-room', alexJwt);
        assert.deepStrictEqual([r.status, r.json().detached], [200, false], 'detaching twice is fine');
        assert.strictEqual((await api('DELETE', '/general/chat-room', samJwt)).status, 403, 'only the owner or staff detach');
        const svc = net.signService({ sub: 'svc:live', cap: ['community.comment.moderate'] });
        r = await api('DELETE', '/general/chat-room', svc);
        assert.deepStrictEqual([r.status, r.json().detached, r.json().chat], [200, true, 'unavailable'], 'a moderator service may detach (Chat keeps its side)');
    });

    await check('the creator whose members\' space it is may attach their room', async () => {
        const r = await api('PUT', '/off-topic/chat-room', samJwt, { room: 'sams-room' });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().chat_room.name, 'Sam\'s Room');
    });

    await chat.close();
    await t.close();
    done();
})();
