'use strict';

/**
 * Author display for comments, threads, posts and Pulse items: Network subjects → names and
 * pictures from subject_projection (refreshed through the Network's resolve-batch, see
 * network.js). AI output is labelled as AI and never attributed to a person (roadmap §33).
 */
const pasteStore = require('../pastes/store');

const AI_DISPLAY_NAME = 'OpenVibe AI';

function createAuthors({ db, network = null }) {
    /** Map subject → projection row (bounded wait for missing ones when the Network is there). */
    async function projectionsFor(subjects) {
        const list = (subjects || []).filter(Boolean);
        if (!list.length) return new Map();
        if (!network) return pasteStore.getProjections(db, list);
        try { return await network.projections(list); } catch { return pasteStore.getProjections(db, list); }
    }

    /**
     * { subject, username, display_name, avatar_url, profile_color } for a person, a fixed AI
     * label for AI output, the Discord name (relayName; is_relay) for a reply written on Discord,
     * null for anonymous writes.
     */
    function author(subject, origin, projections, relayName = null) {
        if (origin === 'ai') return { subject: null, username: null, display_name: AI_DISPLAY_NAME, avatar_url: null, profile_color: null, is_ai: true };
        if (origin === 'discord') return { subject: null, username: null, display_name: relayName || 'Discord', avatar_url: null, profile_color: null, is_relay: true, relay: 'discord' };
        if (origin === 'system' && !subject) return { subject: null, username: null, display_name: 'OpenVibe', avatar_url: null, profile_color: null, is_system: true };
        if (!subject) return null;
        const p = projections.get(subject);
        return {
            subject,
            username: p ? p.username : null,
            display_name: p ? (p.display_name || p.username) : null,
            avatar_url: p ? p.avatar_url : null,
            profile_color: p ? p.profile_color : null,
        };
    }

    return { projectionsFor, author };
}

module.exports = { createAuthors, AI_DISPLAY_NAME };
