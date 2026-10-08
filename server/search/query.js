'use strict';
/**
 * OpenVibe.Search's query API for Community's /search page (roadmap WS-O task 10: product search boxes
 * use the query API). Asked anonymously at Search's internal origin, so it answers with public,
 * published, indexable documents only: exactly what Community sent as public (./documents.js).
 *
 *   search({ q, type, cursor }) → { results, next_cursor }   throws SearchUnavailable when Search does not answer
 */
const TYPES = new Set(['thread', 'paste']);

class SearchUnavailable extends Error {
    constructor(message) { super(message); this.unavailable = true; }
}

function createSearchQuery({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 4000 }) {
    const base = String(baseUrl).replace(/\/+$/, '');
    async function search({ q, type = '', cursor = '', limit = 20 }) {
        const params = new URLSearchParams({ q: String(q).slice(0, 200), owner: 'community', limit: String(limit) });
        if (TYPES.has(type)) params.set('type', type);
        if (cursor && /^[A-Za-z0-9_-]{1,512}$/.test(cursor)) params.set('cursor', cursor);
        let res;
        try {
            res = await fetchImpl(`${base}/api/v1/search?${params}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        } catch (err) {
            throw new SearchUnavailable(`Search did not answer: ${err.message}`);
        }
        const body = await res.json().catch(() => null);
        if (res.status === 400 && body) return { results: [], next_cursor: null, bad_query: true };
        if (!res.ok || !body || !Array.isArray(body.results)) throw new SearchUnavailable(`Search answered ${res.status}`);
        return { results: body.results, next_cursor: body.next_cursor || null };
    }
    return { search };
}

module.exports = { createSearchQuery, SearchUnavailable, TYPES };
