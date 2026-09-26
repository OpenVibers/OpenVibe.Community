'use strict';
/**
 * Stand-ins for Discord in the relay tests.
 *
 * startWebhooks(): an HTTP server speaking the webhook API the relay uses:
 *   POST   /api/webhooks/:id/:token?wait=true[&thread_id=]   → 200 the message { id, channel_id, webhook_id } (204 without wait)
 *   PATCH  /api/webhooks/:id/:token/messages/:mid[?thread_id] → 200 the message
 *   DELETE /api/webhooks/:id/:token/messages/:mid[?thread_id] → 204
 *   an unknown or deleted message → 404 { code: 10008, message: 'Unknown Message' }
 * Message ids count up from 1100000000000000000; a webhook's channel is 2000000000000000000 + its id,
 * or the thread_id it was sent to. `plan` queues canned answers ({ status, body, headers } or
 * { hang: true }) that take precedence; `hits` records every request.
 *
 * createGateway(): a fake WebSocket class (gw.WebSocket) the gateway client is given, with the
 * server side scripted by the test: gw.sockets, gw.push(sock, payload), gw.drop(sock, code), and
 * gw.onOpen / gw.onSend hooks. Sockets open on the next tick.
 */
const http = require('http');

function startWebhooks() {
    const hits = [];
    const plan = [];
    const messages = new Map();
    let next = 1100000000000000000n;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://discord.test');
            const body = raw ? JSON.parse(raw) : null;
            hits.push({ method: req.method, path: u.pathname + u.search, pathname: u.pathname, query: Object.fromEntries(u.searchParams), body });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
            const canned = plan.shift();
            if (canned) {
                if (canned.hang) return undefined;
                res.writeHead(canned.status, { 'Content-Type': 'application/json', ...(canned.headers || {}) });
                return res.end(canned.body ? JSON.stringify(canned.body) : '');
            }
            const m = u.pathname.match(/^\/api\/webhooks\/(\d+)\/([^/]+)(?:\/messages\/(\d+))?$/);
            if (!m) return json(404, { message: 'Unknown Webhook', code: 10015 });
            const [, hookId, , mid] = m;
            if (req.method === 'POST' && !mid) {
                const id = String(next++);
                const channelId = u.searchParams.get('thread_id') || String(2000000000000000000n + BigInt(hookId));
                messages.set(id, { id, channel_id: channelId, webhook_id: hookId, body, deleted: false });
                if (u.searchParams.get('wait') !== 'true') { res.writeHead(204); return res.end(); }
                return json(200, { id, channel_id: channelId, webhook_id: hookId, content: body && body.content });
            }
            const msg = mid ? messages.get(mid) : null;
            if (!msg || msg.deleted) return json(404, { message: 'Unknown Message', code: 10008 });
            if (req.method === 'PATCH') { msg.body = body; return json(200, { id: msg.id, channel_id: msg.channel_id, webhook_id: msg.webhook_id, content: body && body.content }); }
            if (req.method === 'DELETE') { msg.deleted = true; res.writeHead(204); return res.end(); }
            return json(405, { message: '405: Method Not Allowed', code: 0 });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, hits, plan, messages,
        close: () => new Promise((r) => server.close(r)),
    })));
}

function createGateway() {
    const gw = { sockets: [], onOpen: null, onSend: null };
    gw.WebSocket = class FakeWebSocket extends EventTarget {
        constructor(url) {
            super();
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.closedWith = null;
            gw.sockets.push(this);
            setImmediate(() => {
                if (this.readyState !== 0) return;
                this.readyState = 1;
                this.dispatchEvent(new Event('open'));
                if (gw.onOpen) gw.onOpen(this);
            });
        }
        send(data) {
            const p = JSON.parse(data);
            this.sent.push(p);
            if (gw.onSend) gw.onSend(this, p);
        }
        close(code = 1000, reason = '') {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.closedWith = code;
            setImmediate(() => this.dispatchEvent(Object.assign(new Event('close'), { code, reason })));
        }
    };
    gw.push = (sock, payload) => sock.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) }));
    gw.drop = (sock, code, reason = '') => { sock.readyState = 3; sock.dispatchEvent(Object.assign(new Event('close'), { code, reason })); };
    gw.last = () => gw.sockets[gw.sockets.length - 1];
    return gw;
}

module.exports = { startWebhooks, createGateway };
