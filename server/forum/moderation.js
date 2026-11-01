'use strict';

/**
 * The public moderation log's vocabulary (migrations/0012_forum_moderation_log.sql): the actions a
 * moderator can take, the rules a space may cite, and the actor roles a row may name. The row never
 * carries the moderator's Network subject; the role is all the public log says about who acted.
 */
const { fail } = require('../http/v1');

const ACTIONS = Object.freeze(['lock', 'unlock', 'pin', 'unpin', 'hide', 'delete', 'status']);
const ROLES = Object.freeze(['moderator', 'owner', 'staff', 'automatic']);
// Spaces have no rules field of their own yet, so every space cites this network-wide list.
const RULES = Object.freeze(['spam', 'off-topic', 'harassment', 'illegal content', 'personal information', 'duplicate', 'other']);

/** The posted rule, from the allowed list only (case-insensitive), or null. */
function rule(value) {
    if (value === undefined || value === null || value === '') return null;
    const r = String(value).trim().toLowerCase();
    if (!RULES.includes(r)) fail(400, 'moderation.invalid_rule', `The rule is one of ${RULES.join(', ')}`);
    return r;
}

/** The posted reason as plain one-line text, trimmed and capped at 280 characters, or null. */
function reason(value) {
    if (value === undefined || value === null) return null;
    const r = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return r ? r.slice(0, 280) : null;
}

/** { rule, reason } from a form or API body, with the rule and reason rules above. */
function fields(body = {}) {
    return { rule: rule(body.rule), reason: reason(body.reason) };
}

/**
 * Who acted, in role only: discussion staff, the space's owner, or one of its moderators.
 * `isStaff` is the caller's discussions-moderator answer (identity/capabilities.js).
 */
function actorRole(viewer, space, isStaff) {
    if (isStaff) return 'staff';
    if (space && viewer && viewer.subject && (space.created_by === viewer.subject || space.members_only_owner === viewer.subject)) return 'owner';
    return 'moderator';
}

module.exports = { ACTIONS, ROLES, RULES, rule, reason, fields, actorRole };
