'use strict';
/**
 * A stand-in for OpenVibe.Live's /api/pastes surface: enough of the list / get / by-user /
 * create endpoints to render every page, plus an echo of whatever else arrives so the proxy
 * tests can see exactly what was forwarded.
 */
const http = require('http');

const FIXTURES = [
    { id: 1, slug: 'amber-fox-42', user_id: 7, username: 'alex', display_name: 'Alex', avatar_url: '/data/avatars/alex.png', type: 'paste', title: 'Hello world in JavaScript', content: 'const greet = (name) => {\n  return `Hello, ${name}!`;\n};\nconsole.log(greet("OpenVibe"));\n', language: 'javascript', visibility: 'public', views: 120, likes: 3, created_at: '2026-09-15 10:00:00', updated_at: '2026-09-15 10:00:00' },
    { id: 2, slug: 'blue-lake-17', user_id: 9, username: 'sam', display_name: 'Sam', type: 'paste', title: 'nginx snippet', content: 'server {\n  listen 80;\n}\n', language: 'nginx', visibility: 'public', views: 900, likes: 0, created_at: '2026-09-14 09:00:00', updated_at: '2026-09-14 09:00:00' },
    { id: 3, slug: 'cold-ridge-88', user_id: 7, username: 'alex', display_name: 'Alex', type: 'paste', title: 'python helper', content: 'def add(a, b):\n    return a + b\n', language: 'python', visibility: 'public', views: 15, likes: 1, created_at: '2026-09-13 08:00:00', updated_at: '2026-09-13 08:00:00' },
    { id: 4, slug: 'dark-owl-55', user_id: 7, username: 'alex', display_name: 'Alex', type: 'paste', title: 'secret notes', content: 'unlisted <script>alert(1)</script>', language: 'text', visibility: 'unlisted', views: 2, likes: 0, created_at: '2026-09-12 08:00:00', updated_at: '2026-09-12 08:00:00' },
    { id: 5, slug: 'fair-moon-23', user_id: 9, username: 'sam', display_name: 'Sam', type: 'screenshot', title: 'Desktop shot', content: 'my desktop', language: 'text', visibility: 'public', screenshot_url: '/p/fair-moon-23/screenshot', views: 40, likes: 0, created_at: '2026-09-11 08:00:00', updated_at: '2026-09-11 08:00:00' },
    { id: 6, slug: 'grim-vale-61', user_id: 7, username: 'alex', display_name: 'Alex', type: 'paste', title: 'private thing', content: 'private', language: 'text', visibility: 'private', views: 0, likes: 0, created_at: '2026-09-10 08:00:00', updated_at: '2026-09-10 08:00:00' },
];

function start() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const url = new URL(req.url, 'http://live');
            const call = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
            calls.push(call);
            const auth = req.headers.authorization || '';
            const signedIn = auth === 'Bearer good-token' || auth.startsWith('Bearer eyJ');
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            const publicOnly = FIXTURES.filter((p) => p.visibility === 'public');

            if (req.method === 'GET' && url.pathname === '/api/pastes') {
                let rows = publicOnly;
                if (url.searchParams.get('type')) rows = rows.filter((p) => p.type === url.searchParams.get('type'));
                const q = url.searchParams.get('search');
                if (q) rows = rows.filter((p) => (p.title + p.content).toLowerCase().includes(q.toLowerCase()));
                const limit = Number(url.searchParams.get('limit') || 50), offset = Number(url.searchParams.get('offset') || 0);
                return json(200, { pastes: rows.slice(offset, offset + limit).map((p) => ({ ...p, content: p.type === 'paste' ? p.content.slice(0, 300) : null })), total: rows.length, limit, offset });
            }
            let m;
            if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/pastes\/by-user\/([^/]+)$/))) {
                const username = decodeURIComponent(m[1]);
                if (!FIXTURES.some((p) => p.username === username)) return json(404, { error: 'User not found' });
                const rows = FIXTURES.filter((p) => p.username === username && (signedIn || p.visibility === 'public'));
                return json(200, { pastes: rows, total: rows.length, username });
            }
            if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/pastes\/([^/]+)$/))) {
                const p = FIXTURES.find((x) => x.slug === decodeURIComponent(m[1]));
                if (!p || (p.visibility === 'private' && !signedIn)) return json(404, { error: 'Paste not found' });
                if (p.slug === 'burned') return json(410, { error: 'burned' });
                return json(200, { paste: { ...p, views: p.views + (url.searchParams.get('no_view') === '1' ? 0 : 1) } });
            }
            if (req.method === 'POST' && url.pathname === '/api/pastes') {
                let parsed = {}; try { parsed = JSON.parse(body.toString('utf8')); } catch { /* */ }
                if (!parsed.content) return json(400, { error: 'Content is required' });
                if (parsed.title === 'slow down') return json(429, { error: 'Please wait 30s', cooldown: 30 });
                return json(201, { id: 99, slug: 'new-paste-99', url: '/p/new-paste-99', paste: { slug: 'new-paste-99', ...parsed, user_id: signedIn ? 7 : null } });
            }
            if (req.method === 'POST' && url.pathname === '/api/pastes/screenshot') {
                return json(201, { paste: { slug: 'shot-100' }, url: '/p/shot-100', received: body.length, contentType: req.headers['content-type'] || null });
            }
            // Everything else: echo, so proxy tests can inspect the forwarded request.
            json(200, { echo: true, method: req.method, path: url.pathname, query: call.query, headers: req.headers, body: body.toString('utf8') });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        fixtures: FIXTURES,
        close: () => new Promise((r) => server.close(r)),
    })));
}

module.exports = { start, FIXTURES };
