'use strict';
/**
 * OpenVibe.Chat rooms for spaces (roadmap WS-I task 4): a space's owner or staff attach a chat room to
 * the space; the space page links it.
 *
 * Each side checks its own end. Community decides who may change the space (forum/service.js); Chat
 * decides who may attach the room: the person must manage it (its owner, or chat staff). Community asks
 * Chat on the person's behalf with the person's OWN Network token (the ov_token they are signed in with),
 * so no service grant or new capability is involved:
 *
 *   POST   <chat>/api/chat/rooms/:room/attachments { service: 'community', resource: <space slug>, title }
 *          201 attached, 200 already attached (idempotent) → { room: { id, slug, name, kind, visibility } }
 *   DELETE <chat>/api/chat/rooms/:room/attachments/community/:space   (the room's managers or who attached it)
 *
 * Chat's answers become Community's: 404 (no such room, or a private room the person is not in: Chat
 * says nothing more), 403 (not the room's owner), 401 (the token expired). Chat unreachable: 503.
 */
const { fail } = require('./http/v1');

const ROOM_SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;

/** A room slug from "night-owls", "/r/night-owls" or "https://openvibe.chat/r/night-owls"; null otherwise. */
function parseRoomRef(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s || s.length > 300) return null;
    const m = s.match(/^(?:https?:\/\/[^/\s]+)?\/r\/([^/?#\s]+)\/?(?:[?#].*)?$/i);
    const slug = (m ? m[1] : s).toLowerCase();
    return ROOM_SLUG.test(slug) ? slug : null;
}

function createChatRooms({ config, fetchImpl = globalThis.fetch } = {}) {
    const chat = (config && config.chat) || {};
    const base = chat.internalUrl || '';
    const timeoutMs = chat.timeoutMs || 4000;
    const publicUrl = chat.url || 'https://openvibe.chat';

    async function call(method, path, token, body) {
        if (!base) fail(503, 'chat_room.unavailable', 'Chat rooms cannot be attached right now');
        let res;
        try {
            res = await fetchImpl(`${base}${path}`, {
                method,
                headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            fail(503, 'chat_room.unavailable', 'OpenVibe.Chat did not answer. Try again in a minute');
        }
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        return { status: res.status, data };
    }

    /** Ask Chat to attach `room` to `space` as the person holding `token`. → { room, created } */
    async function attach({ token, room, space, title }) {
        if (!token) fail(403, 'chat_room.person_only', 'Attach a chat room while signed in with your own account');
        const r = await call('POST', `/api/chat/rooms/${encodeURIComponent(room)}/attachments`, token, { service: 'community', resource: space, title: title || undefined });
        if ((r.status === 200 || r.status === 201) && r.data && r.data.room && r.data.room.slug) {
            const x = r.data.room;
            return {
                created: r.status === 201,
                room: { id: Number(x.id) || null, slug: String(x.slug), name: String(x.name || x.slug).slice(0, 80), kind: String(x.kind || 'community'), visibility: x.visibility === 'private' ? 'private' : 'public' },
            };
        }
        if (r.status === 404) fail(404, 'chat_room.not_found', 'No such chat room (or it is private and you are not in it)');
        if (r.status === 403) fail(403, 'chat_room.not_owner', 'Only the chat room\'s owner can attach it to a space');
        if (r.status === 401) fail(401, 'auth.required', 'Sign in again to attach a chat room');
        if (r.status === 422) fail(400, 'chat_room.invalid', (r.data && r.data.error) || 'Chat refused that attachment');
        fail(502, 'chat_room.unavailable', 'OpenVibe.Chat could not attach the room right now');
    }

    /** Tell Chat the space let go of the room; best effort. → 'detached' | 'not_allowed' | 'unavailable' */
    async function detach({ token, room, space }) {
        if (!token || !base) return 'unavailable';
        try {
            const r = await call('DELETE', `/api/chat/rooms/${encodeURIComponent(room)}/attachments/community/${encodeURIComponent(space)}`, token);
            if (r.status === 200) return 'detached';
            if (r.status === 403 || r.status === 404) return 'not_allowed';
            return 'unavailable';
        } catch { return 'unavailable'; }
    }

    const roomUrl = (slug) => `${publicUrl}/r/${encodeURIComponent(slug)}`;

    return { attach, detach, roomUrl, parseRoomRef };
}

module.exports = { createChatRooms, parseRoomRef, ROOM_SLUG };
