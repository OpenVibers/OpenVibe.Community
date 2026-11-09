'use strict';

/**
 * A draft another OpenVibe site may carry into the forum through a share link
 * (/forum/discuss?title=…&body=…). The new-thread form's own limits apply: title 200 characters,
 * body 40,000. Both are plain text; the renderer escapes them when it fills the form. A link never
 * posts: the person still reviews and submits the form themselves.
 */
const MAX_TITLE = 200;
const MAX_BODY = 40_000;

/** The first string of a query value (Express hands an array for a repeated parameter). */
function text(value) {
    if (Array.isArray(value)) return value.find((v) => typeof v === 'string') || '';
    return typeof value === 'string' ? value : '';
}

/** The title and body a share link carries, cut to the form's limits. */
function draftPrefill(query = {}) {
    return {
        title: text(query.title).slice(0, MAX_TITLE),
        body: text(query.body).slice(0, MAX_BODY),
    };
}

module.exports = { draftPrefill, MAX_TITLE, MAX_BODY };
