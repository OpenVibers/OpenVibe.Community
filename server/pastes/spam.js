'use strict';
/**
 * Link spam from signed-out posters. A paste without an account that would be public and looks like an advert for a
 * link is kept, but unlisted: it gets a secret slug, so anyone with the link still opens it, and it is never listed,
 * searchable or indexed. A signed-in person's paste and an AI paste are never checked.
 *
 * 2026-10-22: the one spam paste so far was 367 characters with one link, recruiting for an "18+ creator opportunity".
 * So a paste is unlisted when, title and text together, it has
 *   - three or more links, or
 *   - a link and advertising words (PROMO), or
 *   - a link and under SHORT characters of text besides it (a paste that is mostly its link).
 * Code, logs and notes with a link or two in a longer text pass. Nothing is refused and nothing is hidden from its
 * poster: the answer says why, and signing in publishes it.
 */
const LINK_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"')\]]*/gi;
const PROMO = /\b(?:18\+|onlyfans|fansly|casino|betting|sportsbook|viagra|cialis|escort|webcam model|cam (?:model|girl)s?|creator opportunit(?:y|ies)|work from home|make money|earn \$?\d|passive income|crypto signals?|forex|payday loan|buy followers|followers? for sale|seo services?|backlinks?|telegram @|whatsapp \+?\d)/i;
const SHORT = 600;
const NOTICE = 'Signed-out pastes that advertise a link are unlisted: anyone with this link can open it, but it is not listed or searchable. Sign in to publish a paste.';

/** → { unlist, reason, links } for a would-be public paste from someone signed out. */
function linkSpam({ title = '', content = '' } = {}) {
    const text = `${title || ''}\n${content || ''}`;
    const links = text.match(LINK_RE) || [];
    if (!links.length) return { unlist: false, reason: null, links: 0 };
    const rest = links.reduce((s, l) => s.replace(l, ' '), text).replace(/\s+/g, ' ').trim();
    const reason = links.length >= 3 ? 'links' : PROMO.test(text) ? 'promotion' : rest.length < SHORT ? 'mostly_link' : null;
    return { unlist: Boolean(reason), reason, links: links.length };
}

module.exports = { linkSpam, NOTICE, SHORT };
