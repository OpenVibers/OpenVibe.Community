'use strict';
/**
 * Platform blocks (roadmap WS-E task 5; Contracts 0.49.0 network.block.changed).
 *
 * People block each other once, on OpenVibe.Network, and Community honours it: nobody replies in a forum
 * thread whose author blocked them, replies to a comment whose author blocked them, or comments on a paste
 * (or a forum post's comment thread) whose owner blocked them. Network announces every change as
 * network.block.changed (blocker, blocked, active, a per-pair revision); ../pulse/consumer.js applies each
 * one here, keeping only the newest revision per (blocker, blocked), so a late or replayed event never
 * undoes a newer one. Moderation (hide, lock, delete, statuses) is never affected by a block.
 */
const { validate } = require('openvibe-contracts');
const { fail } = require('../http/v1');

const SUBJECT_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const ready = new WeakSet();

function ensureSchema(db) {
    if (ready.has(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS network_blocks (
        blocker_subject TEXT NOT NULL,
        blocked_subject TEXT NOT NULL,
        active          INTEGER NOT NULL,
        revision        INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (blocker_subject, blocked_subject)
    );
    CREATE INDEX IF NOT EXISTS idx_network_blocks_blocked ON network_blocks(blocked_subject, active);`);
    ready.add(db);
}

/** The payload of a network.block.changed envelope from Network, or an 'ignored:*' reason. */
function payloadOf(event) {
    if (!event || event.source !== 'network') return 'ignored:source';
    const p = event.payload;
    if (!p || typeof p !== 'object' || !validate('network.block.changed@1', p).valid) return 'ignored:payload';
    return p;
}

/** Apply one change when it is newer than what is kept for its pair. → 'blocks:blocked' | 'blocks:unblocked' | 'blocks:unchanged' */
function apply(db, p, now = Date.now()) {
    ensureSchema(db);
    const r = db.prepare(`INSERT INTO network_blocks (blocker_subject, blocked_subject, active, revision, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(blocker_subject, blocked_subject) DO UPDATE SET active = excluded.active, revision = excluded.revision, updated_at = excluded.updated_at
        WHERE excluded.revision > network_blocks.revision`).run(p.blocker, p.blocked, p.active ? 1 : 0, p.revision, now);
    if (!r.changes) return 'blocks:unchanged';
    return p.active ? 'blocks:blocked' : 'blocks:unblocked';
}

/** Did `blocker` block `blocked` (subjects)? */
function hasBlocked(db, blocker, blocked) {
    if (!SUBJECT_RE.test(String(blocker || '')) || !SUBJECT_RE.test(String(blocked || '')) || blocker === blocked) return false;
    ensureSchema(db);
    return !!db.prepare('SELECT 1 FROM network_blocks WHERE blocker_subject = ? AND blocked_subject = ? AND active = 1').get(blocker, blocked);
}

/**
 * Refuse (403 community.blocked) when any of `owners` blocked `writer`. `what` names the thing in the
 * message: "You cannot <what>: its author blocked you".
 */
function refuseIfBlocked(db, owners, writer, what, whose = 'its author') {
    if (!writer) return;
    for (const owner of owners) {
        if (hasBlocked(db, owner, writer)) fail(403, 'community.blocked', `You cannot ${what}: ${whose} blocked you`);
    }
}

module.exports = { ensureSchema, payloadOf, apply, hasBlocked, refuseIfBlocked };
