'use strict';
const { canonicalSlug } = require('./pastes/url');

/**
 * Sharing on Community pastes (design 2026-11-06, plan track Q; openvibe-sdk/share).
 *
 * The SDK owns the model and the rules: `shares` rows next to each paste, the one access check
 * (canView), members, access requests, transfers, the append-only log and the delivery queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json     Network's identity lookups (identity.subject.resolve): @name → subject, and
 *                      a person's username/display name/avatar for the sheet.
 *   - events.publish   Community's Events outbox (server/events.js), so share.* envelopes go out
 *                      through the same at-least-once queue as every other community.* event.
 *   - notify           Network's notification push (network.notifications.push); a refusal (the
 *                      grant not seeded yet) is logged, never allowed to stall the delivery queue.
 *   - onAudienceChange keeps pastes.visibility in step (public→public, link→unlisted,
 *                      people→private, private→private) and queues a Search refresh, so an old
 *                      reader that only knows the column fails closed and a people paste leaves
 *                      search at once.
 *   - onOwnerChange    moves pastes.owner_subject and hands the screenshot's Media object to the
 *                      new owner (media.moveOwner).
 *
 * The gate: a person not on a `people` list gets `gate()` — the audience, and their own pending
 * transfer if they are the recipient — never a title, content, screenshot or comment count.
 */
const { AsyncLocalStorage } = require('node:async_hooks');
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');
const config = require('./config');
const events = require('./events');

const SERVICE = 'community';
const KIND = 'paste';
const AUDIENCES = ['public', 'link', 'people', 'private'];
const VISIBILITY = { public: 'public', link: 'unlisted', people: 'private', private: 'private' };
/**
 * Who is acting, while a share call runs. Network's locker key directory (GET /api/v1/people/:id/keys) is a *person*
 * route: a service token is refused there, while openvibe-sdk/share asks for a person's key with its own service
 * client. So the acting person's Network token travels with the call: the lookup is one they may make themselves, and
 * only public keys come back. The token is never stored or logged.
 */
const actor = new AsyncLocalStorage();

/** A paste's share ref: { service: 'community', kind: 'paste', id: <slug> }. */
const refOf = (slug) => ({ service: SERVICE, kind: KIND, id: String(slug) });

/** Community's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

function createSharing({ db, media = null, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || config.networkUrl).replace(/\/+$/, '');
    const tokens = serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`,
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network',
        scope: 'identity.subject.resolve network.notifications.push',
        fetchImpl,
    });

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        // A person's public keys, as the person asking: Network answers this route for a signed-in account, not a service.
        const keysPath = /^\/api\/v1\/people\/[^/]+\/keys$/.test(path);
        const acting = actor.getStore();
        const headers = { Accept: 'application/json', ...(keysPath && acting && acting.token
            ? { Authorization: `Bearer ${acting.token}` }
            : await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        // Network names a person's public keys ecdh_public/signing_public (server/locker/keys.js); openvibe-sdk/share's
        // key slots read ecdh/signing. One spelling here, so the Locker's own names stay what Network publishes.
        if (keysPath && body && body.ecdh_public && !body.ecdh) {
            return { ...body, ecdh: body.ecdh_public, signing: body.signing_public };
        }
        return body;
    }

    /** One notification, addressed by canonical subject (Network resolves it). Never carries a paste title. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['A paste was shared with you', 'Open it on OpenVibe Community.'],
            'share.access_requested': ['Someone asked for access to your paste', 'Review the request on OpenVibe Community.'],
            'share.transfer.requested': ['Someone wants to give you a paste', 'Accept or decline it on OpenVibe Community.'],
            'share.transfer.answered': ['A paste transfer was answered', 'See what happened on OpenVibe Community.'],
        }[n.kind] || ['Sharing on OpenVibe Community', 'There is something new for you.'];
        try {
            await networkJson({
                path: '/internal/notifications/push', method: 'POST',
                json: {
                    subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                    service: 'community', url: n.ref && n.ref.id ? `${config.baseUrl}/p/${encodeURIComponent(n.ref.id)}` : `${config.baseUrl}/`,
                    category: 'social',
                },
            });
        } catch (err) {
            // Network may not have seeded Community's network.notifications.push grant yet: the share
            // still happened (it is decided by canView), the person just hears about it elsewhere.
            log.warn('[Sharing] notification not sent:', err.message);
        }
    }

    let searchDocs = null;
    const refreshSearch = (slug) => {
        if (!searchDocs) return;
        try {
            const p = db.prepare('SELECT * FROM pastes WHERE slug = ? AND deleted_at IS NULL').get(String(slug));
            Promise.resolve(p).then((row) => (row ? searchDocs.publishPaste(row) : searchDocs.removePaste(String(slug)))).catch(() => {});
        } catch { /* Search catches up on its next scan */ }
    };

    async function onAudienceChange(ref, audience, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        // A burn-after-reading paste ends on its first read: it cannot name people who must each read it.
        if (audience === 'people') {
            const p = await tx.maybe('SELECT burn_after_read FROM pastes WHERE slug = $1 AND deleted_at IS NULL', [ref.id]);
            if (p && Number(p.burn_after_read)) {
                const { ShareError } = require('openvibe-sdk/share');
                throw new ShareError(400, 'share.invalid', 'Burn-after-reading pastes cannot be shared with specific people');
            }
        }
        await tx.exec('UPDATE pastes SET visibility = $1, updated_at = ov_now() WHERE slug = $2 AND deleted_at IS NULL', [VISIBILITY[audience] || 'private', ref.id]);
        await tx.exec(`UPDATE threads SET deleted_at = CASE WHEN $1 = 'public' THEN NULL ELSE ov_now() END
            WHERE external_key = 'community:paste:' || $2 AND space_id = (SELECT id FROM spaces WHERE slug = 'pastes')`, [audience, ref.id]);
        tx.afterCommit(() => refreshSearch(ref.id));
    }

    async function onOwnerChange(ref, from, to, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        const owner = to && to.type === 'user' ? to.id : null;
        await tx.exec('UPDATE pastes SET owner_subject = $1, updated_at = ov_now() WHERE slug = $2 AND deleted_at IS NULL', [owner, ref.id]);
        // The screenshot follows its paste: the Media object's owner is the new owner. A failure here
        // is logged by the caller; the paste's access is already decided by the share row.
        if (!media || typeof media.moveOwner !== 'function') return;
        const row = await tx.maybe('SELECT slug, media_ref, screenshot_url, metadata FROM pastes WHERE slug = $1 AND deleted_at IS NULL', [ref.id]);
        if (row && (row.media_ref || row.screenshot_url)) {
            // Re-host the bytes privately under the new owner after the ownership change commits:
            // Media has no "change the owner" route, so the object is replaced, never shared.
            tx.afterCommit(async () => {
                try { await media.moveOwner(row, owner); }
                catch (err) { log.warn('[Sharing] media owner not moved:', err.message); }
            });
        }
    }

    /**
     * A re-sealed envelope (openvibe-sdk/share): removing somebody from a people-locked paste seals the content again
     * under a fresh key, and the service stores those bytes before the member row goes. Community keeps them in the
     * paste's own row; it never opens them.
     */
    async function onReseal(ref, bytes, tx) {
        if (ref.service !== SERVICE || ref.kind !== KIND) return;
        await tx.exec('UPDATE pastes SET envelope = $1, updated_at = ov_now() WHERE slug = $2 AND deleted_at IS NULL',
            [Buffer.from(bytes).toString('base64'), ref.id]);
    }

    const shares = createShares({
        db,
        network: { json: networkJson },
        events: { publish: async (envelope) => await events.publish(envelope) },
        notify,
        onOwnerChange,
        onAudienceChange,
        onReseal,
    });

    /** The share row's audience, for the page's gate and its generic link preview. Null when unregistered. */
    async function shareOf(slug) {
        return await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, KIND, String(slug)]);
    }

    /** The viewer's pending transfer on this paste, if they are its recipient (they may look before accepting). */
    async function pendingTransfer(viewer, slug) {
        const who = shareViewer(viewer);
        if (!who) return null;
        const row = await db.maybe(`SELECT * FROM share_transfers WHERE service = $1 AND kind = $2 AND resource_id = $3
            AND state = 'pending' AND expires_at > now() AND to_subject = $4::jsonb`, [SERVICE, KIND, String(slug), JSON.stringify(who.subject)]);
        if (!row) return null;
        return { id: row.id, from: row.from_subject, keep_access: row.keep_access, requested_at: new Date(row.requested_at).toISOString(), expires_at: new Date(row.expires_at).toISOString(), state: row.state };
    }

    /** What the page may say to somebody who cannot open the paste: the audience, and their own offer. */
    async function gate(viewer, slug) {
        const s = await shareOf(slug);
        if (!s) return { audience: null, transfer: null };
        return { audience: s.audience, transfer: s.audience === 'people' ? await pendingTransfer(viewer, slug) : null };
    }

    /** The one access check, from a Community viewer. */
    async function canView(viewer, slug) {
        return await shares.canView(shareViewer(viewer), refOf(slug));
    }

    /**
     * canView for a paste row: a row without a share record predates the backfill (a fixture, or a row
     * written by a migration), so the old column decides — failing closed for private. A registered
     * row that denied stays denied.
     */
    async function canViewPaste(viewer, p) {
        if (!p) return false;
        if (await canView(viewer, p.slug)) return true;
        if (await shareOf(p.slug)) return false;
        const v = viewer || {};
        return !(p.visibility === 'private' && !(v.staff || (v.subject && p.owner_subject && v.subject === p.owner_subject)));
    }

    // The SDK calls, from a Community viewer (the router does its own conversion). Each runs with the acting person in
    // the async context, so a locker key lookup asks as them (see `actor` above).
    const sv = (viewer) => shareViewer(viewer);
    const at = (slug) => refOf(slug);
    const as = (viewer, fn) => actor.run({ token: viewer && viewer.kind === 'user' ? viewer.token : null }, fn);

    return {
        /** Run a whole request (the share router) as the person it is for. */
        withActor: (viewer, fn) => as(viewer, fn),
        shares, canView, canViewPaste, gate, shareOf, pendingTransfer, shareViewer, refOf,
        canEdit: async (viewer, slug) => await shares.canEdit(sv(viewer), at(slug)),
        get: async (viewer, slug) => as(viewer, async () => await shares.get(sv(viewer), at(slug))),
        getWithRevision: async (viewer, slug) => as(viewer, async () => await shares.getWithRevision(sv(viewer), at(slug))),
        setAudience: async (viewer, slug, audience) => as(viewer, async () => await shares.setAudience(sv(viewer), at(slug), audience)),
        addMembers: async (viewer, slug, list) => as(viewer, async () => await shares.addMembers(sv(viewer), at(slug), list)),
        removeMember: async (viewer, slug, subject) => as(viewer, async () => await shares.removeMember(sv(viewer), at(slug), subject)),
        update: async (viewer, slug, body, opts) => as(viewer, async () => await shares.update(sv(viewer), at(slug), body, opts)),
        requestAccess: async (viewer, slug) => as(viewer, async () => await shares.requestAccess(sv(viewer), at(slug))),
        dismiss: async (viewer, slug, id) => as(viewer, async () => await shares.dismiss(sv(viewer), at(slug), id)),
        transfer: async (viewer, slug, input) => as(viewer, async () => await shares.transfer(sv(viewer), at(slug), input)),
        accept: async (viewer, slug, id) => as(viewer, async () => await shares.accept(sv(viewer), at(slug), id)),
        decline: async (viewer, slug, id) => as(viewer, async () => await shares.decline(sv(viewer), at(slug), id)),
        cancel: async (viewer, slug, id) => as(viewer, async () => await shares.cancel(sv(viewer), at(slug), id)),
        lookup: async (viewer, name) => as(viewer, async () => await shares.lookup(sv(viewer), name)),
        sharedWithMe: async (viewer, opts) => as(viewer, async () => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) })),
        useSearch: (docs) => { searchDocs = docs || null; },
        /** Expire members and transfers, then send queued events and notifications. */
        async work({ flush = true } = {}) {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/**
 * The uniform API's describe(ref): the sheet shows the paste's title and link to its owner. A locked paste also says
 * where its envelope is, and which audiences make sense: it can never be public, and a people lock is opened by its
 * people, not by whoever holds a link.
 */
function describeRef(db) {
    return async (ref) => {
        if (ref.service !== SERVICE || ref.kind !== KIND) return {};
        const p = await db.maybe('SELECT slug, title, locked, lock_kind, title_shown FROM pastes WHERE slug = $1 AND deleted_at IS NULL', [ref.id]);
        if (!p) return {};
        const out = {
            title: !p.locked || p.title_shown ? (p.title || 'Untitled') : 'A locked paste',
            link: `${config.baseUrl}/p/${encodeURIComponent(canonicalSlug(p))}`,
            roles: ['viewer'],
            audiences: AUDIENCES,
            transferable: true,
        };
        if (p.locked) {
            out.audiences = p.lock_kind === 'people' ? ['people', 'private'] : ['link', 'private'];
            out.envelope_url = `${config.baseUrl}/p/${encodeURIComponent(canonicalSlug(p))}/raw`;
        }
        return out;
    };
}

module.exports = { createSharing, describeRef, shareViewer, refOf, AUDIENCES, VISIBILITY, SERVICE, KIND };
