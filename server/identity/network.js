'use strict';

/**
 * OpenVibe.Network identity client — who a subject is, for display.
 *
 * Community stores people as Network subject ids (usr_… / gst_…). Names and pictures come from
 * the Network's resolve-batch endpoint (capability identity.subject.resolve, called with a
 * client-credentials service token) and are cached in subject_projection. The cache is never
 * authority: an entry older than PROJECTION_TTL_MS is refreshed in the background, a missing one
 * is fetched before the response (bounded by RESOLVE_WAIT_MS so a slow Network only costs names).
 *
 *   POST /internal/identity/resolve-batch
 *     { subject_ids: [...] }  or  { system, type: 'user', ids: [...] }   (≤ 500 per call)
 *     → { results: { <key>: { subject: {type,id}, network_user_id, username, display_name, avatar_url, banned } | null } }
 */
const { serviceAuth } = require('openvibe-contracts');
const store = require('../pastes/store');

const BATCH = 500;
const PROJECTION_TTL_MS = 6 * 60 * 60 * 1000;
const RESOLVE_WAIT_MS = 2500;

function createNetworkIdentity({ config, db, fetchImpl = globalThis.fetch } = {}) {
    const base = config.networkInternalUrl;
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve',
        fetchImpl,
    });

    /** Relative avatar paths the Network hands out are relative to the Network. */
    const absAvatar = (u) => (!u ? null : /^https?:\/\//i.test(u) ? u : `${config.networkUrl}${u.startsWith('/') ? '' : '/'}${u}`);

    async function post(body, retried = false) {
        const res = await fetchImpl(`${base}/internal/identity/resolve-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        });
        // A token the Network no longer accepts (rotated key, revoked client): fetch a new one once.
        if (res.status === 401 && !retried) { tokens.invalidate(); return post(body, true); }
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || typeof data.results !== 'object') {
            const err = new Error(`resolve-batch ${res.status}: ${(data && (data.detail || data.error)) || 'bad response'}`);
            err.status = res.status;
            throw err;
        }
        return data.results;
    }

    /** Resolve many keys in ≤500 chunks. `shape(chunk)` builds the request body. → Map key → projection|null */
    async function resolveChunks(keys, shape) {
        const out = new Map();
        const list = [...new Set(keys.map(String))];
        for (let i = 0; i < list.length; i += BATCH) {
            const chunk = list.slice(i, i + BATCH);
            const results = await post(shape(chunk));
            for (const k of chunk) out.set(k, results[k] || null);
        }
        return out;
    }

    /** Store a Network projection in the cache. */
    function remember(p) {
        if (!p || !p.subject || !p.subject.id) return;
        store.upsertProjection(db, {
            subject_id: p.subject.id, username: p.username || null, display_name: p.display_name || p.username || null,
            avatar_url: absAvatar(p.avatar_url), profile_color: p.profile_color || null,
        });
    }

    /** Subject ids → projections (and cache them). */
    async function resolveSubjects(subjectIds) {
        const map = await resolveChunks(subjectIds, (chunk) => ({ subject_ids: chunk }));
        for (const p of map.values()) remember(p);
        return map;
    }

    /** Legacy ids of one system ('live' | 'network') → projections. Used by the importer. */
    async function resolveLegacy(system, ids, { cache = true } = {}) {
        const map = await resolveChunks(ids, (chunk) => ({ system, type: 'user', ids: chunk }));
        if (cache) for (const p of map.values()) remember(p);
        return map;
    }

    /**
     * The subject of a Network account id, for user JWTs issued before tokens carried
     * `subject_id`. Cached durably in legacy_id_map (network/user/<id> → subject).
     */
    async function subjectForNetworkUser(networkUserId) {
        if (networkUserId == null || networkUserId === '') return null;
        const hit = store.mapGet(db, 'network', 'user', networkUserId);
        if (hit && hit.target_type === 'subject') return hit.target_id;
        const map = await resolveLegacy('network', [networkUserId]);
        const p = map.get(String(networkUserId));
        if (!p || !p.subject || p.subject.type !== 'user') return null;
        store.mapSet(db, 'network', 'user', networkUserId, 'subject', p.subject.id);
        return p.subject.id;
    }

    /** What a verified user JWT says about its holder is a fresh projection too. */
    function rememberClaims(subjectId, claims) {
        if (!subjectId || !claims) return;
        store.upsertProjection(db, {
            subject_id: subjectId, username: claims.username || null, display_name: claims.display_name || claims.username || null,
            avatar_url: absAvatar(claims.avatar_url), profile_color: claims.profile_color || null,
        });
    }

    let inflight = null;
    const pending = new Set();
    /** Background refresh of stale entries, batched and deduplicated. */
    function refreshLater(ids) {
        for (const id of ids) pending.add(id);
        if (inflight) return;
        inflight = Promise.resolve().then(async () => {
            while (pending.size) {
                const batch = [...pending].slice(0, BATCH);
                batch.forEach((id) => pending.delete(id));
                try { await resolveSubjects(batch); } catch (err) { console.warn('[Identity] projection refresh failed:', err.message); pending.clear(); }
            }
        }).finally(() => { inflight = null; });
    }

    /**
     * Projections for display. Missing entries are fetched now (bounded wait); stale ones are
     * served as they are and refreshed behind the response. → Map subject_id → projection row
     */
    async function projections(subjectIds) {
        const ids = [...new Set((subjectIds || []).filter((s) => typeof s === 'string' && /^(usr|gst)_/.test(s)))];
        if (!ids.length) return new Map();
        let map = store.getProjections(db, ids);
        const missing = ids.filter((id) => !map.has(id));
        const stale = ids.filter((id) => map.has(id) && Date.now() - Date.parse(String(map.get(id).refreshed_at).replace(' ', 'T') + 'Z') > PROJECTION_TTL_MS);
        if (stale.length) refreshLater(stale);
        if (missing.length) {
            let timer;
            const wait = new Promise((resolve) => { timer = setTimeout(resolve, RESOLVE_WAIT_MS); });
            // The lookup keeps running (and fills the cache) if the wait runs out first.
            const lookup = resolveSubjects(missing).catch((err) => console.warn('[Identity] resolve-batch failed:', err.message));
            await Promise.race([lookup, wait]);
            clearTimeout(timer);
            map = store.getProjections(db, ids);
        }
        return map;
    }

    return { resolveSubjects, resolveLegacy, subjectForNetworkUser, rememberClaims, projections, tokens };
}

module.exports = { createNetworkIdentity, PROJECTION_TTL_MS };
