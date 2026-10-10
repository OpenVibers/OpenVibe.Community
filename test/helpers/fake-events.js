'use strict';
/**
 * A stand-in for OpenVibe.Events in the relay tests: the publish route Community's outbox uses and
 * the pull route the relay's Events worker reads.
 *
 *   POST /api/v1/events   one envelope or { events: [...] } → { event_id, seq, duplicate } | { results }
 *   GET  /api/v1/events?topic=a.*,b.*&after=<cursor>|after_seq=&limit=
 *        → { events: [{ seq, cursor, event }], next_after_seq, next_cursor, latest_seq, latest_cursor, gap? }
 *   Cursors are opaque to the worker; here, as in Events, `c1.<epoch>.<base64url(seq)>` (one epoch, 0).
 *
 * Topic patterns follow Events (`*` is one or more whole segments). Every call needs a Bearer token.
 * `failNext` answers that many calls with 503; `prunedThrough` makes seq ≤ it look pruned (a gap).
 */
const http = require('http');

function matcher(pattern) {
    return new RegExp(`^${pattern.split('.').map((s) => (s === '*' ? '[a-z0-9_]+(?:\\.[a-z0-9_]+)*' : s)).join('\\.')}$`);
}

const encode = (seq) => `c1.0.${Buffer.from(String(seq), 'utf8').toString('base64url')}`;
const decode = (c) => { const m = /^c1\.0\.([A-Za-z0-9_-]+)$/.exec(String(c)); return m ? Number(Buffer.from(m[1], 'base64url').toString('utf8')) : NaN; };

function startEvents() {
    const log = [];      // { seq, event }
    const calls = [];
    const state = { failNext: 0, prunedThrough: 0 };
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://events.test');
            calls.push({ method: req.method, path: u.pathname + u.search, auth: req.headers.authorization || null });
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (!/^Bearer \S+/.test(req.headers.authorization || '')) return json(401, { type: 'about:blank', code: 'auth.required', status: 401 });
            if (state.failNext > 0) { state.failNext--; return json(503, { type: 'about:blank', code: 'events.unavailable', status: 503, detail: 'down for a test' }); }
            if (u.pathname === '/api/v1/events' && req.method === 'POST') {
                const body = JSON.parse(raw || '{}');
                const batch = Array.isArray(body.events);
                const results = (batch ? body.events : [body]).map((env) => {
                    const known = log.find((x) => x.event.event_id === env.event_id);
                    if (known) return { event_id: env.event_id, seq: known.seq, duplicate: true };
                    const seq = log.length + 1;
                    log.push({ seq, event: env });
                    return { event_id: env.event_id, seq, duplicate: false };
                });
                return json(201, batch ? { results } : results[0]);
            }
            if (u.pathname === '/api/v1/events' && req.method === 'GET') {
                const patterns = String(u.searchParams.get('topic') || '*').split(',').map(matcher);
                const cur = u.searchParams.get('after');
                const after = cur ? decode(cur) : Number(u.searchParams.get('after_seq') || 0);
                if (!Number.isFinite(after)) return json(400, { type: 'about:blank', code: 'events.bad_request', status: 400, detail: 'after must be an opaque cursor' });
                const limit = Number(u.searchParams.get('limit') || 100);
                const out = {};
                let from = after;
                if (state.prunedThrough && after < state.prunedThrough) { out.gap = { from_seq: after + 1, to_seq: state.prunedThrough }; from = state.prunedThrough; }
                const rows = [];
                let cursor = from;
                for (const item of log) {
                    if (item.seq <= from) continue;
                    cursor = item.seq;
                    if (patterns.some((re) => re.test(item.event.event_type))) rows.push(item);
                    if (rows.length >= limit) break;
                }
                out.events = rows.map((r) => ({ ...r, cursor: encode(r.seq) }));
                out.next_after_seq = cursor;
                out.next_cursor = encode(cursor);
                out.latest_seq = log.length;
                out.latest_cursor = encode(log.length);
                return json(200, out);
            }
            return json(404, { type: 'about:blank', code: 'route.not_found', status: 404 });
        });
    });
    /** Put an event straight into the log (as if some producer had published it). → seq */
    function add(event) { log.push({ seq: log.length + 1, event }); return log.length; }
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`, log, calls, state, add, encode,
        close: () => new Promise((r) => server.close(r)),
    })));
}

module.exports = { startEvents };
