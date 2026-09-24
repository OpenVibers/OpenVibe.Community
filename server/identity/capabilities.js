'use strict';

/**
 * Capability checks for service tokens, including the ids Community introduces before the
 * contracts library knows them.
 *
 * openvibe-contracts' capabilities.check() answers capability.unknown for an id that is not in
 * its manifests yet. The ids below are proposed in docs/capabilities-proposal/ and go into a
 * contracts release; until then a grant is decided locally with the library's own matching rule
 * (the exact id, or a `prefix.*` grant covering it). An id the library does know always goes
 * through the library, so the day the release lands nothing changes here.
 */
const { capabilities } = require('openvibe-contracts');

const PROPOSED = new Set([
    'community.comment.write',
    'community.comment.moderate',
    'community.pulse.write',
    'community.post.create',
]);

/** → { allowed, code, reason } like capabilities.check(). */
function checkCapability(claims, capabilityId) {
    if (!capabilities.get(capabilityId) && PROPOSED.has(capabilityId)) {
        return capabilities.grants(claims && claims.cap, capabilityId)
            ? { allowed: true, code: null, reason: null }
            : { allowed: false, code: 'capability.denied', reason: `${capabilityId} not granted` };
    }
    return capabilities.check(claims, capabilityId);
}

/** Does this viewer's service token grant the capability? (Browsers and anonymous: never.) */
function serviceHas(viewer, capabilityId) {
    return !!(viewer && viewer.kind === 'service' && checkCapability(viewer.claims, capabilityId).allowed);
}

/**
 * Staff for discussions (comments, forum, relay admin): a browser holding staff.moderation.discussions, or a
 * service that vouches for a staff person with X-OV-Staff: 1 and holds community.comment.moderate.
 */
function discussionStaff(viewer) {
    if (!viewer) return false;
    if (viewer.kind === 'user') return !!(viewer.discussionStaff !== undefined ? viewer.discussionStaff : viewer.staff);
    return viewer.kind === 'service' && !!viewer.vouchesStaff && serviceHas(viewer, 'community.comment.moderate');
}

/**
 * A discussion moderator: discussion staff, or a service holding community.comment.moderate that
 * acts as itself (no X-OV-Subject) — e.g. an owner service hiding the thread of an entity it took
 * down. A service acting for a person moderates only when it vouches that person is staff.
 */
function discussionModerator(viewer) {
    return discussionStaff(viewer) || (!!viewer && viewer.kind === 'service' && !viewer.subject && serviceHas(viewer, 'community.comment.moderate'));
}

module.exports = { checkCapability, serviceHas, discussionStaff, discussionModerator, PROPOSED };
