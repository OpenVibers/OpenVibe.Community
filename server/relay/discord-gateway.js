'use strict';

/**
 * A minimal Discord gateway client (API v10, JSON, no compression) for the relay's inbound side
 * (roadmap WS-J task 6; DISCORD_RELAY_INBOUND=on with DISCORD_BOT_TOKEN).
 *
 * One session: HELLO → IDENTIFY (or RESUME on resume_gateway_url after a drop); heartbeats at the
 * interval Discord asks for, the first one jittered, and a heartbeat that was not ACKed by the next
 * one means a zombied connection (closed, then resumed); op 1 asks for a heartbeat now; op 7
 * RECONNECT resumes; op 9 INVALID_SESSION identifies again (or resumes when Discord says it may).
 * Reconnects back off exponentially (minBackoffMs · 2^n, at most maxBackoffMs), reset once READY or
 * RESUMED. Close codes that reconnecting cannot heal (4004 a wrong token; 4010–4014 shard, version
 * or intents) stop it, with the reason shown to staff; 4007 and 4009 start a fresh session.
 *
 * Intents: GUILD_MESSAGES | MESSAGE_CONTENT (privileged: turn it on for the bot in the Developer
 * Portal). MESSAGE_CREATE / MESSAGE_UPDATE / MESSAGE_DELETE / MESSAGE_DELETE_BULK go to onDispatch
 * (relay/inbound.js); everything else is dropped here. The WebSocket is the client built into
 * Node 22 (no dependency); without one the gateway stays off and says so. The token never leaves
 * the IDENTIFY/RESUME payloads and is never logged.
 */
const INTENTS = { GUILD_MESSAGES: 1 << 9, MESSAGE_CONTENT: 1 << 15 };
const DEFAULT_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const FATAL = {
    4004: 'authentication failed: DISCORD_BOT_TOKEN is wrong',
    4010: 'invalid shard',
    4011: 'sharding required (the bot is in too many servers for one connection)',
    4012: 'invalid gateway API version',
    4013: 'invalid intents',
    4014: 'disallowed intents: turn on the MESSAGE CONTENT intent for the bot in the Discord Developer Portal',
};
const FRESH = new Set([4007, 4009]);
const DISPATCH = new Set(['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK']);
const OPEN = 1;

/** The gateway URL with the version and encoding this client speaks (a resume URL comes without them). */
function withQuery(u) {
    try {
        const url = new URL(u);
        url.searchParams.set('v', '10');
        url.searchParams.set('encoding', 'json');
        return url.toString();
    } catch { return u; }
}

function createDiscordGateway({ token = '', url = DEFAULT_URL, WebSocketImpl = globalThis.WebSocket, onDispatch = () => {}, intents = INTENTS.GUILD_MESSAGES | INTENTS.MESSAGE_CONTENT, minBackoffMs = 1000, maxBackoffMs = 60_000, helloTimeoutMs = 30_000, invalidSessionMs = 1000, jitter = Math.random, now = () => Date.now() } = {}) {
    let reason = null;
    if (!token) reason = 'DISCORD_BOT_TOKEN is not set';
    else if (typeof WebSocketImpl !== 'function') reason = 'this Node has no built-in WebSocket client (Node 22 or later)';
    const on = !reason;
    const state = { status: on ? 'idle' : 'off', session_id: null, seq: null, resume_url: null, bot_user_id: null, last_error: null, last_reconnect: null, ready_at: null, connects: 0, reconnects: 0, dispatched: 0 };
    let ws = null;
    let firstBeat = null;
    let beats = null;
    let reconnectTimer = null;
    let helloTimer = null;
    let acked = true;
    let failures = 0;
    let stopped = true;

    const iso = () => new Date(now()).toISOString();
    function send(obj) {
        if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(obj));
    }
    function clearHeartbeat() {
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = null;
        if (firstBeat) clearTimeout(firstBeat);
        if (beats) clearInterval(beats);
        firstBeat = null;
        beats = null;
    }
    function beat() {
        acked = false;
        send({ op: 1, d: state.seq });
    }
    function heartbeatEvery(ms) {
        clearHeartbeat();
        acked = true;
        const interval = Math.max(Number(ms) || 41_250, 10);
        firstBeat = setTimeout(() => {
            firstBeat = null;
            beat();
            beats = setInterval(() => {
                if (!acked) return reconnect('no heartbeat ACK (zombied connection)');
                beat();
            }, interval);
            if (beats.unref) beats.unref();
        }, Math.floor(interval * jitter()));
        if (firstBeat.unref) firstBeat.unref();
    }

    function connect() {
        reconnectTimer = null;
        if (stopped) return;
        const resuming = !!(state.session_id && state.resume_url);
        state.status = resuming ? 'resuming' : 'connecting';
        state.connects++;
        let sock;
        try {
            sock = new WebSocketImpl(resuming ? withQuery(state.resume_url) : url);
        } catch (err) {
            state.last_error = `cannot open the gateway: ${err.message}`;
            return scheduleReconnect();
        }
        ws = sock;
        helloTimer = setTimeout(() => { helloTimer = null; if (ws === sock) reconnect('no HELLO from the gateway'); }, helloTimeoutMs);
        if (helloTimer.unref) helloTimer.unref();
        sock.addEventListener('message', (ev) => { if (ws === sock) onMessage(ev.data); });
        sock.addEventListener('close', (ev) => { if (ws === sock) onClose(ev.code, ev.reason); });
        sock.addEventListener('error', () => { /* a close event follows */ });
    }

    function onMessage(raw) {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')); } catch { return; }
        if (!p || typeof p !== 'object') return;
        switch (p.op) {
            case 10: // HELLO
                heartbeatEvery(p.d && p.d.heartbeat_interval);   // also clears the HELLO timeout
                if (state.session_id && state.seq != null) send({ op: 6, d: { token, session_id: state.session_id, seq: state.seq } });
                else send({ op: 2, d: { token, intents, properties: { os: process.platform, browser: 'openvibe-community', device: 'openvibe-community' } } });
                break;
            case 11: // HEARTBEAT_ACK
                acked = true;
                break;
            case 1: // HEARTBEAT (asked for one now)
                beat();
                break;
            case 7: // RECONNECT
                reconnect('Discord asked to reconnect');
                break;
            case 9: // INVALID_SESSION (d: may resume)
                if (!p.d) { state.session_id = null; state.seq = null; state.resume_url = null; }
                reconnect('invalid session', invalidSessionMs + Math.floor(jitter() * 4 * invalidSessionMs));   // Discord: wait 1 to 5 s
                break;
            case 0: // DISPATCH
                if (p.s != null) state.seq = p.s;
                dispatch(p.t, p.d);
                break;
            default:
                break;
        }
    }

    function dispatch(t, d) {
        if (t === 'READY') {
            state.session_id = d && d.session_id ? String(d.session_id) : null;
            state.resume_url = d && d.resume_gateway_url ? String(d.resume_gateway_url) : null;
            state.bot_user_id = d && d.user && d.user.id ? String(d.user.id) : null;
            state.status = 'ready';
            state.ready_at = iso();
            state.last_error = null;
            failures = 0;
            return;
        }
        if (t === 'RESUMED') {
            state.status = 'ready';
            state.last_error = null;
            failures = 0;
            return;
        }
        if (!DISPATCH.has(t)) return;
        state.dispatched++;
        try {
            const r = onDispatch(t, d || {}, { botUserId: state.bot_user_id });
            if (r && typeof r.catch === 'function') r.catch((err) => console.warn(`[Relay] inbound ${t} failed:`, err.message));
        } catch (err) {
            console.warn(`[Relay] inbound ${t} failed:`, err.message);
        }
    }

    function onClose(code, why) {
        clearHeartbeat();
        ws = null;
        if (stopped) { state.status = 'stopped'; return; }
        if (FATAL[code]) {
            state.status = 'failed';
            state.last_error = `Discord closed the gateway (${code}): ${FATAL[code]}`;
            console.warn(`[Relay] ${state.last_error}; inbound stays off until a restart`);
            return;
        }
        if (FRESH.has(code)) { state.session_id = null; state.seq = null; state.resume_url = null; }
        state.last_error = `gateway closed (${code}${why ? `: ${String(why).slice(0, 200)}` : ''})`;
        state.last_reconnect = { reason: state.last_error, at: iso() };
        scheduleReconnect();
    }

    /** Drop this connection (keeping the session, so the next one resumes) and connect again. */
    function reconnect(why, delayMs = null) {
        const sock = ws;
        ws = null;
        clearHeartbeat();
        state.last_error = why;
        state.last_reconnect = { reason: why, at: iso() };
        if (sock) { try { sock.close(4000, why.slice(0, 120)); } catch { /* already closed */ } }
        scheduleReconnect(delayMs);
    }

    function scheduleReconnect(delayMs = null) {
        if (stopped || reconnectTimer) return;
        failures++;
        state.reconnects++;
        state.status = 'waiting';
        const delay = delayMs != null ? delayMs : Math.min(minBackoffMs * Math.pow(2, Math.max(failures - 1, 0)), maxBackoffMs);
        reconnectTimer = setTimeout(connect, delay);
        if (reconnectTimer.unref) reconnectTimer.unref();
    }

    function start() {
        if (!on || !stopped) return;
        stopped = false;
        failures = 0;
        connect();
    }
    /** Close the connection (1000) and cancel every timer. */
    function stop() {
        stopped = true;
        clearHeartbeat();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        const sock = ws;
        ws = null;
        if (sock) { try { sock.close(1000, 'stopping'); } catch { /* already closed */ } }
        if (on) state.status = 'stopped';
        return Promise.resolve();
    }

    function status() {
        if (!on) return { enabled: false, reason };
        return {
            enabled: true, state: state.status, session: !!state.session_id, bot_user_id: state.bot_user_id,
            ready_at: state.ready_at, connects: state.connects, reconnects: state.reconnects, last_reconnect: state.last_reconnect, events_handled: state.dispatched, last_error: state.last_error,
        };
    }

    return { enabled: on, reason, start, stop, status, _state: state };
}

module.exports = { createDiscordGateway, INTENTS, DEFAULT_URL, FATAL };
