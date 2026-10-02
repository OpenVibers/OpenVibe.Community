'use strict';

/**
 * Submissions — clips, art, ideas and reports people send in for community review.
 *
 *   - Signed-in people submit (a browser's JWT subject, usr_…); signed-out visitors and services do
 *     not: openvibe-contracts has no submission capability yet, so there is nothing for a service to hold.
 *   - A new submission is pending: only its author and discussion moderators
 *     (identity/capabilities.js discussionModerator) see it. Accepted ones are public; rejected and
 *     withdrawn ones go back to being seen by their author and moderators only (anyone else: 404).
 *   - The author withdraws (pending or accepted); a moderator accepts or rejects (pending, or a decision
 *     already made), with an optional note the author sees.
 *   - Accepted submissions enter Pulse as the author's (origin user); leaving accepted takes them out
 *     again, and Pulse re-checks the status on every read (pulse/store.js).
 *   - A clip or picture stays in OpenVibe.Media: a submission keeps a link (url) and/or a med_ reference.
 *
 * Identity only ever comes from the viewer (JWT or service token), never from a body.
 */
const store = require('./store');
const { fail, sqlTime, isoTime, encodeCursor, decodeCursor } = require('../http/v1');
const { discussionModerator } = require('../identity/capabilities');
const { createAuthors } = require('../identity/authors');

const KINDS = ['clip', 'art', 'idea', 'report'];
const STATUSES = ['pending', 'accepted', 'rejected', 'withdrawn'];
const PAGE = 30;
const MED_ID = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG_RE = /^[a-z]+-[a-z]+-\d{3,6}$/;
const LIMITS = { title: 200, body: 10000, url: 2000, note: 1000, perDay: 10 };

function createSubmissionService({ db, network = null, pulse = null, indexnow = null, config = {}, limits = {} } = {}) {
    const authors = createAuthors({ db, network });
    const base = (config.baseUrl || '').replace(/\/$/, '');
    const perDay = limits.perDay != null ? limits.perDay : LIMITS.perDay;
    const tell = async (fn) => { if (!pulse) return; try { await fn(pulse); } catch (err) { console.warn('[Submissions] pulse:', err.message); } };
    const ping = (slug) => { if (indexnow && indexnow.enabled) indexnow.pingSoon([`${base}/submissions/${slug}`]); };

    const isAuthor = (v, s) => !!(v && v.kind === 'user' && v.subject && v.subject === s.author_subject);
    const moderates = (v) => discussionModerator(v);
    const canSee = (v, s) => s.status === 'accepted' || isAuthor(v, s) || moderates(v);

    function shape(s, v, projections) {
        const close = isAuthor(v, s) || moderates(v);
        return {
            slug: s.slug,
            kind: s.kind,
            title: s.title,
            body: s.body,
            url: s.url || null,
            media_ref: s.media_ref || null,
            status: s.status,
            author: authors.author(s.author_subject, 'user', projections),
            // Who reviewed and what they said: the author and moderators only.
            reviewer: close && s.reviewer_subject ? authors.author(s.reviewer_subject, 'user', projections) : null,
            review_note: close ? (s.review_note || null) : null,
            reviewed_at: isoTime(s.reviewed_at),
            created_at: isoTime(s.created_at),
            updated_at: isoTime(s.updated_at),
            page_url: `/submissions/${s.slug}`,
            can: { withdraw: isAuthor(v, s) && ['pending', 'accepted'].includes(s.status), review: moderates(v) && s.status !== 'withdrawn' },
        };
    }
    const shapeOne = async (s, v) => shape(s, v, await authors.projectionsFor([s.author_subject, s.reviewer_subject]));

    /** The row a viewer may see, or 404 (never a 403 that confirms a slug exists). */
    async function visible(v, slug) {
        const s = SLUG_RE.test(String(slug || '')) ? await store.getBySlug(db, slug) : null;
        if (!s || !canSee(v, s)) fail(404, 'submission.not_found', 'Submission not found');
        return s;
    }

    function text(value, max, code, what, { required = false } = {}) {
        const t = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
        if (required && !t) fail(400, code, `${what} is required`);
        if (t.length > max) fail(400, code, `${what} is at most ${max} characters`);
        return t;
    }

    return {
        KINDS, STATUSES,
        moderates,

        /** POST /api/v1/submissions { kind, title, body?, url?, media_ref? } — a signed-in person. */
        async create(v, body = {}) {
            if (!v || v.kind === 'anonymous' || !v.subject) fail(401, 'auth.required', 'Sign in to submit');
            if (v.kind !== 'user') fail(403, 'capability.denied', 'Submissions are sent by people, from their browser');
            if (!/^usr_/.test(v.subject)) fail(403, 'submission.account_required', 'Submissions need an OpenVibe account');
            const kind = String(body.kind || '');
            if (!KINDS.includes(kind)) fail(400, 'submission.invalid_kind', `kind must be one of ${KINDS.join(', ')}`);
            const title = text(body.title, LIMITS.title, 'submission.invalid_title', 'A title', { required: true }).replace(/\s+/g, ' ');
            const text_ = text(body.body, LIMITS.body, 'submission.invalid_body', 'The description');
            const url = text(body.url, LIMITS.url, 'submission.invalid_url', 'The link') || null;
            if (url) {
                let parsed = null;
                try { parsed = new URL(url); } catch { /* invalid */ }
                if (!parsed || !/^https?:$/.test(parsed.protocol)) fail(400, 'submission.invalid_url', 'The link must be an http(s) address');
            }
            const mediaRef = String(body.media_ref == null ? '' : body.media_ref).trim() || null;
            if (mediaRef && !MED_ID.test(mediaRef)) fail(400, 'submission.invalid_media_ref', 'media_ref must be an OpenVibe.Media object id (med_…)');
            if ((kind === 'clip' || kind === 'art') && !url && !mediaRef) fail(400, 'submission.media_required', 'A clip or art submission needs a link or a Media object');
            if (!text_ && !url && !mediaRef) fail(400, 'submission.empty', 'Describe it, link it, or both');
            if (perDay > 0 && await store.countByAuthorSince(db, v.subject, sqlTime(Date.now() - 86_400_000)) >= perDay) {
                fail(429, 'submission.daily_limit', `At most ${perDay} submissions a day — try again tomorrow`, { retry_after: 3600 });
            }
            const row = await store.insert(db, { slug: await store.generateSlug(db), kind, title, body: text_, url, media_ref: mediaRef, author_subject: v.subject });
            return { submission: await shapeOne(row, v) };
        },

        /** GET /api/v1/submissions/:slug */
        async get(v, slug) {
            return { submission: await shapeOne(await visible(v, slug), v) };
        },

        /**
         * GET /api/v1/submissions ?kind=&status=&mine=1&after=&limit=
         * Everyone: accepted. mine=1: the signed-in person's own, any status. Moderators: any status.
         */
        async list(v, q = {}) {
            const kind = q.kind == null || q.kind === '' ? null : String(q.kind);
            if (kind && !KINDS.includes(kind)) fail(400, 'submission.invalid_kind', `kind must be one of ${KINDS.join(', ')}`);
            let status = q.status == null || q.status === '' ? null : String(q.status);
            if (status && !STATUSES.includes(status)) fail(400, 'submission.invalid_status', `status must be one of ${STATUSES.join(', ')}`);
            const mine = q.mine === '1' || q.mine === 'true' || q.mine === true;
            let author = null;
            if (mine) {
                if (!v || v.kind !== 'user' || !v.subject) fail(401, 'auth.required', 'Sign in to see your submissions');
                author = v.subject;
            } else if (!moderates(v)) {
                if (status && status !== 'accepted') fail(403, 'submission.moderators_only', 'Only moderators see submissions under review');
                status = 'accepted';
            }
            const limit = Math.min(Math.max(parseInt(q.limit, 10) || PAGE, 1), 100);
            const before = decodeCursor(q.after, 2);
            const { rows, hasMore } = await store.list(db, { status, author, kind, before, limit });
            const projections = await authors.projectionsFor(rows.flatMap((r) => [r.author_subject, r.reviewer_subject]));
            const last = rows[rows.length - 1];
            return { submissions: rows.map((r) => shape(r, v, projections)), next_cursor: hasMore && last ? encodeCursor([last.created_at, last.id]) : null };
        },

        /** POST /api/v1/submissions/:slug/withdraw — the author, while pending or accepted. */
        async withdraw(v, slug) {
            const s = await visible(v, slug);
            if (!isAuthor(v, s)) fail(403, 'submission.not_author', 'Only its author withdraws a submission');
            const next = await store.setStatus(db, s.id, { status: 'withdrawn', from: ['pending', 'accepted'] });
            if (!next) fail(409, 'submission.not_withdrawable', `A ${s.status} submission cannot be withdrawn`);
            if (s.status === 'accepted') { await tell((p) => p.submissionGone(s.slug)); ping(s.slug); }
            return { submission: await shapeOne(next, v) };
        },

        /** POST /api/v1/submissions/:slug/review { decision: accept|reject, note? } — moderators. */
        async review(v, slug, body = {}) {
            if (!moderates(v)) {
                if (!v || v.kind === 'anonymous') fail(401, 'auth.required', 'Sign in to review');
                await visible(v, slug);   // 404 first for what this viewer may not see
                fail(403, 'submission.moderators_only', 'Only moderators review submissions');
            }
            const s = await visible(v, slug);
            const decision = String(body.decision || '');
            if (!['accept', 'reject'].includes(decision)) fail(400, 'submission.invalid_decision', 'decision must be accept or reject');
            const note = text(body.note, LIMITS.note, 'submission.invalid_note', 'The note') || null;
            const status = decision === 'accept' ? 'accepted' : 'rejected';
            const next = await store.setStatus(db, s.id, { status, from: ['pending', 'accepted', 'rejected'], reviewer_subject: v.subject || null, review_note: note, reviewed: true });
            if (!next) fail(409, 'submission.withdrawn', 'Its author withdrew this submission');
            if (status === 'accepted') await tell((p) => p.submissionAccepted(next));
            else await tell((p) => p.submissionGone(next.slug));
            if (s.status === 'accepted' || status === 'accepted') ping(s.slug);
            return { submission: await shapeOne(next, v) };
        },
    };
}

module.exports = { createSubmissionService, KINDS, STATUSES, LIMITS };
