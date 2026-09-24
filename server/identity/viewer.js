'use strict';

/**
 * Who is calling — resolved once per request into `req.viewer`:
 *
 *   { kind: 'anonymous' }
 *   { kind: 'user',    subject: 'usr_…'|null, staff, user: <JWT claims> }
 *       A browser with the Network user JWT (ov_token cookie or Bearer). The subject comes from
 *       the token's subject_id; older tokens without one are resolved through the Network.
 *       role admin/global_mod makes the viewer staff. X-OV-* headers are ignored for browsers.
 *   { kind: 'service', service: 'svc:live', claims, subject: 'usr_…'|'gst_…'|null, origin, sourceRef, staff }
 *       A first-party service holding a Network client-credentials token for audience
 *       openvibe.community. It names the person it acts for in X-OV-Subject; with no subject the
 *       write is anonymous, unless X-OV-Origin: ai says it is AI output (never attributed to a
 *       person: subject stays null). X-OV-Source-Ref may carry a JSON EntityRef (e.g. the stream).
 *       X-OV-Staff: 1 vouches that the acting person is staff; it needs community.paste.moderate
 *       (pastes) or community.comment.moderate (comments and the forum).
 *       Developer-app (app:…) and module (mod:…) tokens act only for the person in their
 *       on_behalf_of claim: X-OV-Subject naming anyone else is refused, and sandbox tokens are too.
 *
 * Identity never comes from a request body or query. A request that presents a service token is
 * judged on that token alone: a bad one is refused, never downgraded to anonymous.
 */
const contracts = require('openvibe-contracts');
const { extractToken, claimsToUser, decodeJwtPayload } = require('../auth/routes');
const { checkCapability } = require('./capabilities');

const { ids, capabilities, serviceAuth, http } = contracts;
const { staff: staffMap } = require('openvibe-contracts');
// The roles that hold staff moderation today (kept for callers; gates ask staffMap.can instead).
const STAFF_ROLES = new Set(['admin', 'global_mod']);
const PRINCIPAL_SUB = /^(svc|app|mod):/;
const AUDIENCE = 'openvibe.community';

class ViewerError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const ANONYMOUS = Object.freeze({ kind: 'anonymous', subject: null, staff: false, origin: 'user' });

function isActingSubject(v) {
    return typeof v === 'string' && (ids.isSubjectId('user', v) || ids.isSubjectId('guest', v));
}

/** Does this viewer's service token grant the capability? (Browsers and anonymous: never.) */
function hasCap(viewer, capabilityId) {
    return !!(viewer && viewer.kind === 'service' && capabilities.check(viewer.claims, capabilityId).allowed);
}

function createViewerResolver({ auth, config, network, revocations = null }) {
    async function fromServiceToken(req, token) {
        const publicKey = await auth.ensureKey();
        if (!publicKey) throw new ViewerError(503, 'identity.unavailable', 'the Network signing key is not loaded yet');
        const r = serviceAuth.verifyServiceToken(token, { publicKey, issuer: config.networkUrl, audience: AUDIENCE });
        if (!r.ok) throw new ViewerError(401, r.code, r.reason);
        const claims = r.claims;
        // Developer apps (app:…) and modules (mod:…) are third parties: they act only for the person
        // who authorized them (the token's on_behalf_of), never for whoever X-OV-Subject names.
        // Only first-party service principals (svc:…) are trusted to name the acting subject.
        const firstParty = claims.actor_type === 'service' && String(claims.sub).startsWith('svc:');
        if (!firstParty && claims.env !== undefined && claims.env !== 'production') {
            throw new ViewerError(401, 'token.sandbox_refused', 'sandbox tokens are not accepted by openvibe.community');
        }

        const originHeader = req.get('x-ov-origin');
        if (originHeader && originHeader !== 'ai' && originHeader !== 'user') throw new ViewerError(400, 'request.invalid_origin', 'X-OV-Origin must be "ai" or "user"');
        const origin = originHeader === 'ai' ? 'ai' : 'user';

        const subjectHeader = req.get('x-ov-subject');
        let subject = null;
        if (subjectHeader) {
            if (!isActingSubject(subjectHeader)) throw new ViewerError(400, 'subject.invalid', 'X-OV-Subject must be a usr_… or gst_… subject id');
            if (!firstParty && subjectHeader !== claims.on_behalf_of) {
                throw new ViewerError(403, 'subject.not_delegated', 'an app acts only for the person who authorized it (on_behalf_of)');
            }
            // AI output is never attributed to a person, even if the caller also names one.
            subject = origin === 'ai' ? null : subjectHeader;
        } else if (!firstParty && ids.isSubjectId('user', claims.on_behalf_of)) {
            subject = origin === 'ai' ? null : claims.on_behalf_of;
        }

        let sourceRef = null;
        const refHeader = req.get('x-ov-source-ref');
        if (refHeader) {
            try { sourceRef = JSON.parse(refHeader); } catch { sourceRef = undefined; }
            if (!sourceRef || !contracts.validate('common.entity-ref@1', sourceRef).valid) {
                throw new ViewerError(400, 'request.invalid_source_ref', 'X-OV-Source-Ref must be a JSON EntityRef {service, type, id}');
            }
        }

        // `staff` is paste staff (community.paste.moderate). `vouchesStaff` records the header for
        // discussions, where it counts together with community.comment.moderate
        // (identity/capabilities.js discussionStaff). Either grant makes the header acceptable.
        let staff = false, vouchesStaff = false;
        if (req.get('x-ov-staff') === '1') {
            const c = capabilities.check(claims, 'community.paste.moderate');
            if (!c.allowed && !checkCapability(claims, 'community.comment.moderate').allowed) {
                throw new ViewerError(403, c.code, 'X-OV-Staff needs community.paste.moderate or community.comment.moderate');
            }
            staff = c.allowed;
            vouchesStaff = true;
        }
        return { kind: 'service', service: claims.sub, claims, subject, origin, sourceRef, staff, vouchesStaff };
    }

    async function fromUserToken(token) {
        const claims = await auth.verify(token);
        if (!claims || (typeof claims.sub === 'string' && PRINCIPAL_SUB.test(claims.sub))) return null;
        // Issued before Network's cutoff for this person (signed out everywhere, password changed, banned).
        if (revocations && revocations.isRevoked(claims)) return null;
        let subject = ids.isSubjectId('user', claims.subject_id) ? claims.subject_id : null;
        if (!subject && network && claims.sub != null) {
            try { subject = await network.subjectForNetworkUser(claims.sub); } catch (err) { console.warn('[Identity] subject lookup failed:', err.message); }
        }
        if (subject && network) { try { network.rememberClaims(subject, claims); } catch { /* display cache only */ } }
        const user = claimsToUser(claims);
        if (subject && !user.subject_id) user.subject_id = subject;
        // Staff powers come from the contracts staff map (ADR-022): the role, or Network's issued staff_caps.
        const staff = staffMap.can(claims, 'staff.moderation.pastes');
        const discussionStaff = staffMap.can(claims, 'staff.moderation.discussions');
        return { kind: 'user', subject, staff, discussionStaff, origin: 'user', user, token };
    }

    /**
     * Resolve the caller. opts.services=false (server-rendered pages) treats a service token as
     * no identity at all: pages are for browsers.
     */
    async function resolve(req, opts = {}) {
        const header = String(req.headers.authorization || '');
        if (header.startsWith('Bearer ')) {
            const token = header.slice(7).trim();
            const payload = decodeJwtPayload(token);
            if (payload && typeof payload.sub === 'string' && PRINCIPAL_SUB.test(payload.sub)) {
                if (opts.services === false) return ANONYMOUS;
                return fromServiceToken(req, token);
            }
        }
        const token = extractToken(req);
        if (!token) return ANONYMOUS;
        return (await fromUserToken(token)) || ANONYMOUS;
    }

    /** Express middleware: sets req.viewer (and req.user/req.token for the page renderers). */
    function middleware(opts = {}) {
        return async (req, res, next) => {
            try {
                req.viewer = await resolve(req, opts);
                if (req.viewer.kind === 'user') { req.user = req.viewer.user; req.token = req.viewer.token; }
                next();
            } catch (err) {
                if (!(err instanceof ViewerError)) return next(err);
                http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov });
            }
        };
    }

    return { resolve, middleware };
}

module.exports = { createViewerResolver, hasCap, isActingSubject, ANONYMOUS, STAFF_ROLES, ViewerError };
