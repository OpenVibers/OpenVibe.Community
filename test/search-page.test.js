'use strict';
/**
 * /search (WS-O task 10: product search boxes use the query API): results come from OpenVibe.Search,
 * asked for Community's documents only; a snippet keeps Search's <mark> and nothing else; no query
 * asks nothing; Search not answering is a 503 page that offers the paste filter; the page is never
 * indexed; the navbar links to it. The client asks Search anonymously with owner=community.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/app');
const { createSearchQuery, SearchUnavailable } = require('../server/search/query');

(async () => {
    const asked = [];
    let down = false;
    const searchQuery = {
        async search(args) {
            asked.push(args);
            if (down) throw new SearchUnavailable('Search did not answer: connect ECONNREFUSED');
            return {
                results: [
                    { owner: 'community', type: 'thread', id: '18', title: 'Forum <b>boards</b>', canonical_url: 'https://openvibe.community/s/roadmap/t/forum-boards', facets: { space: 'roadmap' }, authorship: 'human', updated_at: '2026-09-25T18:37:20.000Z', snippet_html: 'classic <mark>forum</mark> boards <img src=x onerror=alert(1)>' },
                    { owner: 'community', type: 'paste', id: 'amber-fox-42', title: 'Quick sort', canonical_url: 'https://openvibe.community/p/amber-fox-42', facets: { kind: 'paste', syntax: 'javascript' }, authorship: 'ai_generated', summary: 'a sort' },
                ],
                next_cursor: 'abc_123',
            };
        },
    };
    const t = await boot({ appOpts: { searchQuery } });

    await check('results: titles link to the page, the snippet keeps only <mark>, More carries the cursor', async () => {
        const r = await t.get('/search?q=forum&type=thread');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(asked.at(-1), { q: 'forum', type: 'thread', cursor: '' });
        assert.ok(r.text.includes('href="/s/roadmap/t/forum-boards"'));
        assert.ok(r.text.includes('Forum &lt;b&gt;boards&lt;/b&gt;'), 'the title is escaped');
        assert.ok(r.text.includes('classic <mark>forum</mark> boards &lt;img'), 'only <mark> survives');
        assert.ok(!r.text.includes('<img src=x'));
        assert.ok(r.text.includes('Thread in roadmap') && r.text.includes('Paste · javascript') && r.text.includes('>AI</span>'));
        assert.ok(r.text.includes('cursor=abc_123'));
        assert.ok(r.text.includes('noindex,follow'));
    });

    await check('no query asks Search nothing; the navbar links to /search', async () => {
        const n = asked.length;
        const r = await t.get('/search');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(asked.length, n);
        assert.ok(r.text.includes('"href":"/search"'));
    });

    await check('Search not answering: 503, said plainly, with the paste filter', async () => {
        down = true;
        const r = await t.get('/search?q=forum');
        assert.strictEqual(r.status, 503);
        assert.ok(r.text.includes('Search is not answering right now'));
        assert.ok(r.text.includes('href="/pastes?q=forum"'));
    });

    await check('the client asks anonymously for owner=community, drops a malformed cursor, and reports failures', async () => {
        const seen = [];
        const srv = http.createServer((req, res) => {
            seen.push({ url: req.url, auth: req.headers.authorization });
            res.setHeader('content-type', 'application/json');
            if (req.url.includes('q=bad')) { res.statusCode = 400; return res.end('{"code":"search.bad_query"}'); }
            if (req.url.includes('q=boom')) { res.statusCode = 500; return res.end('{}'); }
            res.end(JSON.stringify({ results: [{ id: '1' }], next_cursor: null }));
        });
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const c = createSearchQuery({ baseUrl: `http://127.0.0.1:${srv.address().port}/` });
        const out = await c.search({ q: 'forum', type: 'paste', cursor: 'x y' });
        assert.deepStrictEqual(out, { results: [{ id: '1' }], next_cursor: null });
        const u = new URL(seen[0].url, 'http://x');
        assert.strictEqual(u.pathname, '/api/v1/search');
        assert.strictEqual(u.searchParams.get('owner'), 'community');
        assert.strictEqual(u.searchParams.get('type'), 'paste');
        assert.strictEqual(u.searchParams.get('cursor'), null);
        assert.strictEqual(seen[0].auth, undefined, 'anonymous: public documents only');
        assert.deepStrictEqual(await c.search({ q: 'bad' }), { results: [], next_cursor: null, bad_query: true });
        await assert.rejects(c.search({ q: 'boom' }), SearchUnavailable);
        srv.close();
        await assert.rejects(createSearchQuery({ baseUrl: 'http://127.0.0.1:9' }).search({ q: 'x' }), SearchUnavailable);
    });

    await done(t);
})();
