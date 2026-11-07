'use strict';

/**
 * The public address of a paste, in one place so the page, its Markdown twin, JSON-LD, the feed,
 * Search documents and events can never disagree.
 *
 *   public     /p/<title-slug>-<public_id>   (the title slug is optional: /p/<public_id>)
 *   link/private, burn-after-read   /p/<stored slug>   (the secret part is the access control)
 *
 * <public_id> is 8 base58 characters, stored once per paste (migrations/0012_paste_public_id.sql,
 * scripts/backfill-paste-public-ids.js). The slug part is decoration: lookups use the id, so a
 * retitled paste keeps its address's id and its old title-slug form 301s to the new one.
 */
const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';   // base58: no 0, O, I, l
const PUBLIC_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{8}$/;
const MAX_WORDS = 6;
const MAX_CHARS = 48;

function newPublicId() {
    let out = '';
    for (let i = 0; i < 8; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    return out;
}

/** Lowercase ASCII words, at most six and 48 characters, joined by '-'; '' when there are none. */
function titleSlug(paste) {
    const p = paste || {};
    // A paste called "Untitled" is untitled: its first line of content names it instead.
    const title = String(p.title == null ? '' : p.title).trim();
    const text = !title || title === 'Untitled' ? String(p.content || '').split(/\r?\n/)[0] : title;
    const words = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, MAX_WORDS);
    let out = '';
    for (const word of words) {
        const next = out ? `${out}-${word}` : word;
        if (next.length > MAX_CHARS) break;
        out = next;
    }
    return out;
}

/** The canonical path segment of a paste (without /p/). */
function canonicalSlug(paste) {
    const p = paste || {};
    if (!p.public_id || p.visibility !== 'public' || Number(p.burn_after_read)) return String(p.slug || '');
    const words = titleSlug(p);
    return words ? `${words}-${p.public_id}` : p.public_id;
}

/** The 8-char id in a reference (bare id, or the last '-'-separated part), or null. */
function publicIdOfRef(ref) {
    const s = String(ref == null ? '' : ref);
    if (PUBLIC_ID_RE.test(s)) return s;
    const m = /-([1-9A-HJ-NP-Za-km-z]{8})$/.exec(s);
    return m ? m[1] : null;
}

module.exports = { ALPHABET, PUBLIC_ID_RE, newPublicId, titleSlug, canonicalSlug, publicIdOfRef };
