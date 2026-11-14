'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.Community's JSON API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path the app mounts, with the operation the
 * router serves. server/app.js mounts exactly these, and test/openapi.test.js walks the mounted
 * routers and fails when the two differ in either direction — so the document can never advertise an
 * address this service does not answer.
 *
 *   GET /openapi.json           this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json    308 to /openapi.json
 *
 * /api/health and /api/ready are operational probes, not API surface: they stay out.
 *
 * Request fields come from what the handlers pass into the services (the api.js modules) and what
 * the services validate; response properties are the DTOs' output where the shape is read from code.
 */
const pkg = require('../package.json');
const { RULES: MODERATION_RULES } = require('./forum/moderation');

const SITE = 'https://openvibe.community';

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: { type: 'integer' }, code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 415, 422, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const SLUG = (name) => path(name, str({ pattern: '^[A-Za-z0-9_-]{3,80}$' }), 'The slug');
const SUBJECT = path('subject', { type: 'string', pattern: '^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$' }, 'The person or agent (usr_/agt_ id)');

const ANONYMOUS = [{}, { bearer: [] }, { cookie: [] }];
const PERSON = [{ bearer: [] }, { cookie: [] }];
const SERVICE = [{ bearer: [] }];
const STAFF = [{ bearer: [] }, { cookie: [] }];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });
const nothing = (description) => ({ description });

const pasteVisibility = { type: 'string', enum: ['public', 'unlisted', 'private'], default: 'public', deprecated: true, description: 'The old three words; sharing names the audience' };
const pasteAudience = { type: 'string', enum: ['public', 'link', 'people', 'private'], default: 'public',
    description: 'Everyone, anyone with the link, specific people (members), or only the owner' };
const shareMember = { oneOf: [
    { type: 'string', description: 'An exact @name' },
    { type: 'object', required: ['name'], properties: { name: str(), role: { type: 'string', enum: ['viewer', 'editor'], default: 'viewer' }, expires_at: str({ format: 'date-time' }) } },
] };

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

// ── /api/pastes — the native paste API (server/pastes/api.js) ────────────────────────────────
route('get', '/api/pastes', {
    operationId: 'listPastes', summary: 'Browse pastes', tags: ['pastes'], security: ANONYMOUS, parameters: [
        query('limit', { type: 'integer', minimum: 1, maximum: 200, default: 50 }), query('offset', { type: 'integer', minimum: 0 }),
        query('type', { type: 'string', enum: ['paste', 'screenshot'] }), query('sort', str({ description: 'newest (default) or oldest' })),
        query('origin', str({ description: 'user, ai or system' })), query('search', str({ maxLength: 200 })), query('since', str(), 'Only pastes after this time'),
        query('pinned_first', { type: 'string', description: '0 or false keeps pinned pastes in place' }),
        query('needs_ai', { type: 'string', description: 'Services holding community.paste.moderate only: pastes with no AI pass yet' })],
    responses: { 200: json('A page of pastes', { type: 'object', properties: { pastes: arrayOf(ref('Paste')), total: { type: 'integer' } } }), ...errors([400, 403, 429]) },
});
route('get', '/api/pastes/duplicates', {
    operationId: 'findPasteDuplicate', summary: 'Check for your own matching paste', tags: ['pastes'], security: PERSON,
    parameters: [query('sha256', { type: 'string', pattern: '^[a-fA-F0-9]{64}$', required: true, description: 'SHA-256 of the uploaded bytes' })],
    responses: { 200: json('Whether this person already owns a matching paste', { type: 'object', properties: {
        duplicate: { type: 'boolean' }, object: { type: 'object', properties: { id: str(), name: str(), date: str(), address: str(), url: str() } }, paste: ref('Paste'),
    } }), ...errors([400, 401, 429]) },
});
route('post', '/api/pastes', {
    operationId: 'createPaste', summary: 'Create a paste', tags: ['pastes'], security: PERSON,
    description: 'community.paste.create. The body is JSON, or multipart with a file (then it is a screenshot paste).',
    requestBody: { required: true, content: {
        'application/json': { schema: { type: 'object', required: ['content'], properties: {
            title: str(), content: str(), language: str(), visibility: pasteVisibility, audience: pasteAudience, slug: str(),
            members: { type: 'array', items: shareMember, maxItems: 100, description: 'audience people only: who may open it' },
            transfer_to: str({ description: "An exact @name: offer this paste's ownership in the same call" }),
            keep_access: { type: 'boolean', default: false, description: 'With transfer_to: the current owner keeps viewing' },
            keep_both: { type: 'boolean', default: false, description: 'Create another paste even when these exact bytes already belong to you' },
            burn_after_read: { type: 'boolean' }, is_nsfw: { type: 'boolean' }, stream_id: str({ pattern: '^\\d{1,18}$' }),
            metadata: { type: ['object', 'string'], description: 'Services only: a JSON object kept with the paste' },
            ai_summary: str({ maxLength: 2000, description: 'A service with community.paste.moderate' }),
            ai_tags: { type: ['array', 'string'], description: 'A service with community.paste.moderate' },
            locked: { type: 'boolean', description: 'A Locker paste: send envelope instead of content (see /docs/locked-pastes)' },
            envelope: { type: 'string', description: 'Base64 locker.envelope.v1, instead of content. Community stores it and never sees the content key' },
            show_title: { type: 'boolean', description: 'With locked: keep the title outside the envelope (it is otherwise inside it)' },
        } } },
        'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: {
            file: { type: 'string', format: 'binary' }, title: str(), description: str(), page_url: str(), visibility: pasteVisibility, audience: pasteAudience,
            members: str({ description: 'audience people only: @names, comma or space separated' }), transfer_to: str(), keep_access: { type: 'boolean' }, keep_both: { type: 'boolean', default: false },
            burn_after_read: { type: 'boolean' }, is_nsfw: { type: 'boolean' },
        } } },
    } },
    responses: { 201: json('The paste', { type: 'object', properties: { paste: ref('Paste') } }), ...errors() },
});
route('get', '/api/pastes/config', {
    operationId: 'getPasteConfig', summary: 'The paste editor\'s limits and languages', tags: ['pastes'], security: ANONYMOUS,
    responses: { 200: json('Limits, languages and options'), ...errors([429]) },
});
route('get', '/api/pastes/admin/stats', {
    operationId: 'pasteStats', summary: 'Paste statistics (staff)', tags: ['pastes-admin'], security: STAFF,
    responses: { 200: json('Counts'), ...errors([401, 403, 429]) },
});
route('get', '/api/pastes/admin/stats/series', {
    operationId: 'pasteStatSeries', summary: 'Paste counts over time (staff)', tags: ['pastes-admin'], security: STAFF,
    parameters: [query('since', str()), query('until', str())],
    responses: { 200: json('A series'), ...errors([400, 401, 403, 429]) },
});
route('get', '/api/pastes/admin/forks', {
    operationId: 'listForks', summary: 'Forked pastes (staff)', tags: ['pastes-admin'], security: STAFF,
    parameters: [query('limit', { type: 'integer', minimum: 1, maximum: 500 })],
    responses: { 200: json('Forks'), ...errors([400, 401, 403, 429]) },
});
route('delete', '/api/pastes/admin/forks', {
    operationId: 'deleteForks', summary: 'Remove the forked pastes (staff)', tags: ['pastes-admin'], security: STAFF,
    responses: { 200: json('How many were removed'), ...errors([401, 403, 429]) },
});
route('post', '/api/pastes/bulk', {
    operationId: 'bulkPastes', summary: 'A bulk paste operation (staff)', tags: ['pastes-admin'], security: STAFF,
    requestBody: body({ type: 'object', description: 'The bulk request (server/pastes/service.js bulk)' }),
    responses: { 200: json('The result'), ...errors([400, 401, 403, 429]) },
});
route('post', '/api/pastes/screenshot', {
    operationId: 'createScreenshotPaste', summary: 'Create a screenshot paste (multipart)', tags: ['pastes'], security: PERSON,
    description: 'community.paste.create. The image is stored in OpenVibe.Media.',
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: {
        file: { type: 'string', format: 'binary' }, title: str(), description: str(), page_url: str(), visibility: pasteVisibility,
        burn_after_read: { type: 'boolean' }, is_nsfw: { type: 'boolean' },
    } } } } },
    responses: { 201: json('The paste', { type: 'object', properties: { paste: ref('Paste') } }), ...errors([413, 415]) },
});
route('get', '/api/pastes/by-user/{username}', {
    operationId: 'pastesByUser', summary: 'One person\'s pastes', tags: ['pastes'], security: ANONYMOUS,
    parameters: [path('username', str({ pattern: '^[A-Za-z0-9_-]{1,40}$' }), 'The Network username'),
        query('limit', { type: 'integer', minimum: 1, maximum: 100 }), query('sort', { type: 'string', enum: ['newest', 'oldest'] })],
    responses: { 200: json('Pastes', { type: 'object', properties: { pastes: arrayOf(ref('Paste')), total: { type: 'integer' } } }), ...errors([400, 404, 429]) },
});
route('get', '/api/pastes/{slug}', {
    operationId: 'getPaste', summary: 'One paste (a read counts a view)', tags: ['pastes'], security: ANONYMOUS,
    parameters: [SLUG('slug'), query('no_view', { type: 'string', enum: ['1'] }, 'Do not count this read (never for a burn-after-read paste)')],
    responses: { 200: json('The paste and whether the caller liked it', { type: 'object', properties: { paste: ref('Paste'), liked: { type: 'boolean' } } }), ...errors([400, 404, 429]) },
});
route('put', '/api/pastes/{slug}', {
    operationId: 'updatePaste', summary: 'Edit a paste', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write. pinned is staff only.',
    requestBody: body({ type: 'object', properties: {
        title: str(), content: str(), language: str(), visibility: pasteVisibility, is_nsfw: { type: 'boolean' }, pinned: { type: 'boolean' },
    } }),
    responses: { 200: json('The paste', { type: 'object', properties: { paste: ref('Paste') } }), ...errors() },
});
route('delete', '/api/pastes/{slug}', {
    operationId: 'deletePaste', summary: 'Delete a paste (soft: its address answers 410)', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write. The owner\'s delete answers undo: { until, restore } and can be undone for ten minutes; the paste is hidden at once and cleared after.',
    responses: { 200: json('What was deleted, and until when it can be undone'), ...errors() },
});
route('post', '/api/pastes/{slug}/restore', {
    operationId: 'restorePaste', summary: 'Undo the owner\'s delete, within ten minutes', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write. 410 once the ten minutes have passed (the paste is cleared).',
    responses: { 200: json('The paste, back'), ...errors() },
});
route('post', '/api/pastes/{slug}/censor', {
    operationId: 'censorPaste', summary: 'Replace a paste\'s content with a censorship notice (staff)', tags: ['pastes-admin'], security: STAFF, parameters: [SLUG('slug')],
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, reason: str() } } } } },
    responses: { 200: json('The paste'), ...errors() },
});
route('post', '/api/pastes/{slug}/ai', {
    operationId: 'setPasteAi', summary: 'Record a paste\'s AI summary and tags', tags: ['pastes'], security: SERVICE, parameters: [SLUG('slug')],
    description: 'community.paste.moderate: OpenVibe.Live\'s AI pass writes one paste at a time.',
    requestBody: body({ type: 'object', properties: { ai_summary: str({ maxLength: 2000 }), ai_tags: { type: ['array', 'string'] } } }),
    responses: { 200: json('The paste'), ...errors() },
});
route('get', '/api/pastes/{slug}/raw', {
    operationId: 'getPasteRaw', summary: 'A paste\'s text (302 to the page when it is a screenshot)', tags: ['pastes'], security: ANONYMOUS, parameters: [SLUG('slug')],
    responses: { 200: { description: 'The text (text/plain)' }, 302: { description: 'A screenshot paste: /p/{slug}/raw', headers: { Location: { schema: { type: 'string' } } } }, ...errors([404, 429]) },
});
route('get', '/api/pastes/{slug}/versions', {
    operationId: 'pasteVersions', summary: 'A paste\'s earlier versions', tags: ['pastes'], security: ANONYMOUS, parameters: [SLUG('slug')],
    responses: { 200: json('Versions'), ...errors([404, 429]) },
});
route('post', '/api/pastes/{slug}/fork', {
    operationId: 'forkPaste', summary: 'Fork a paste onto your account', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write.',
    responses: { 201: json('The new paste', { type: 'object', properties: { paste: ref('Paste') } }), ...errors() },
});
route('post', '/api/pastes/{slug}/like', {
    operationId: 'likePaste', summary: 'Like a paste', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write. Idempotent.',
    responses: { 200: json('The new like count'), ...errors([404, 409, 429]) },
});
route('post', '/api/pastes/{slug}/copy', {
    operationId: 'countPasteCopy', summary: 'Count a copy of a paste', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write.',
    responses: { 200: json('The new copy count'), ...errors([404, 429]) },
});
route('get', '/api/pastes/{slug}/comments', {
    operationId: 'listPasteComments', summary: 'A paste\'s comments', tags: ['pastes'], security: ANONYMOUS, parameters: [SLUG('slug'),
        query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    responses: { 200: json('Comments, oldest first', { type: 'object', properties: { comments: arrayOf(ref('PasteComment')) } }), ...errors([404, 429]) },
});
route('post', '/api/pastes/{slug}/comments', {
    operationId: 'addPasteComment', summary: 'Comment on a paste', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    description: 'community.paste.write.',
    requestBody: body({ type: 'object', required: ['message'], properties: {
        message: str(), parent_id: nullable('integer', { minimum: 1 }), anon_name: str({ maxLength: 32, description: 'Anonymous visitors only' }),
    } }),
    responses: { 201: json('The comment', { type: 'object', properties: { comment: ref('PasteComment') } }), ...errors() },
});
route('delete', '/api/pastes/{slug}/comments/{commentId}', {
    operationId: 'deletePasteComment', summary: 'Delete a comment (its author, or staff with community.paste.moderate)', tags: ['pastes'], security: PERSON,
    parameters: [SLUG('slug'), path('commentId', { type: 'integer', minimum: 1 })],
    responses: { 200: json('What was deleted'), ...errors() },
});
route('post', '/api/pastes/{slug}/set-avatar', {
    operationId: 'setPasteAvatar', summary: 'Not here: avatars belong to the Network account (answers 501)', tags: ['pastes'], security: PERSON, parameters: [SLUG('slug')],
    responses: { 501: { description: 'Set your picture on openvibe.network' } },
});

// ── /api/v1/submissions (server/submissions/api.js) ──────────────────────────────────────────
route('get', '/api/v1/submissions', {
    operationId: 'listSubmissions', summary: 'Submissions for review (accepted ones for everyone)', tags: ['submissions'], security: ANONYMOUS, parameters: [
        query('kind', { type: 'string', enum: ['clip', 'art', 'idea', 'report'] }),
        query('status', { type: 'string', enum: ['pending', 'accepted', 'rejected', 'withdrawn'] }, 'Moderators only, except accepted'),
        query('mine', { type: 'string', enum: ['1', 'true'] }, 'Your own, any status'), query('after', str(), 'The next_cursor from the previous page'),
        query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    responses: { 200: json('Submissions and the cursor for the next page', { type: 'object', properties: { submissions: arrayOf(ref('Submission')), next_cursor: nullable('string') } }), ...errors([400, 401, 403, 429]) },
});
route('post', '/api/v1/submissions', {
    operationId: 'createSubmission', summary: 'Submit a clip, art, an idea or a report', tags: ['submissions'], security: PERSON,
    description: 'A signed-in person from their browser; a clip or art needs a link or a Media object.',
    requestBody: body({ type: 'object', required: ['kind', 'title'], properties: {
        kind: { type: 'string', enum: ['clip', 'art', 'idea', 'report'] }, title: str(), body: str(), url: str({ format: 'uri' }),
        media_ref: str({ pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' }),
    } }),
    responses: { 201: json('The submission', { type: 'object', properties: { submission: ref('Submission') } }), ...errors([429]) },
});
route('get', '/api/v1/submissions/{slug}', {
    operationId: 'getSubmission', summary: 'One submission', tags: ['submissions'], security: ANONYMOUS,
    parameters: [path('slug', str(), 'The submission slug')],
    responses: { 200: json('The submission', { type: 'object', properties: { submission: ref('Submission') } }), ...errors([404, 429]) },
});
route('post', '/api/v1/submissions/{slug}/withdraw', {
    operationId: 'withdrawSubmission', summary: 'Withdraw your submission', tags: ['submissions'], security: PERSON,
    parameters: [path('slug', str())],
    responses: { 200: json('The submission', { type: 'object', properties: { submission: ref('Submission') } }), ...errors([403, 404, 409, 429]) },
});
route('post', '/api/v1/submissions/{slug}/review', {
    operationId: 'reviewSubmission', summary: 'Accept or reject a submission (moderators)', tags: ['submissions'], security: PERSON,
    parameters: [path('slug', str())],
    requestBody: body({ type: 'object', required: ['decision'], properties: {
        decision: { type: 'string', enum: ['accept', 'reject'] }, note: str(),
    } }),
    responses: { 200: json('The submission', { type: 'object', properties: { submission: ref('Submission') } }), ...errors([404, 409, 429]) },
});

// ── /api/v1/comments — the comment threads other products embed (server/comments/api.js) ─────
route('post', '/api/v1/comments/attachments', {
    operationId: 'uploadCommentAttachment', summary: 'Upload one comment attachment through the item owner', tags: ['comments'], security: PERSON,
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['ref', 'file'], properties: {
        ref: { type: 'string', description: 'JSON EntityRef, for example {"service":"community","type":"paste","id":"…"}' },
        file: { type: 'string', format: 'binary' },
    } } } } },
    responses: { 201: json('A staged ai.file@1 reference to pass in the comment write', { type: 'object', properties: { attachment: { type: 'object' } } }), ...errors([400, 401, 403, 413, 429, 502, 503]) },
});
route('post', '/api/v1/comments/threads/resolve', {
    operationId: 'resolveThread', summary: 'Open the thread for an item (creating it the first time)', tags: ['comments'], security: PERSON,
    description: 'community.thread.resolve. Idempotent: 201 when it created the thread, 200 when it already existed.',
    requestBody: body({ type: 'object', required: ['ref'], properties: { ref: { type: 'object', description: 'The item: { service, type, id }' } } }),
    responses: { 200: json('The thread', { type: 'object', properties: { thread: ref('Thread'), created: { const: false } } }),
        201: json('The thread', { type: 'object', properties: { thread: ref('Thread'), created: { const: true } } }), ...errors() },
});
route('get', '/api/v1/comments/threads/{id}', {
    operationId: 'getThread', summary: 'A thread and one page of its comments', tags: ['comments'], security: ANONYMOUS, parameters: [
        path('id', str(), 'The thread id'), query('limit', { type: 'integer', minimum: 1, maximum: 100 }),
        query('after', { type: 'integer', minimum: 1 }, 'The last comment id of the previous page'),
        query('sort', { type: 'string', enum: ['old', 'new'] }), query('parent', { type: 'integer', minimum: 1 }, 'Page one comment\'s replies instead')],
    responses: { 200: json('The thread, its comments, the cursor and what the viewer may do', { type: 'object', properties: {
        thread: ref('Thread'), comments: arrayOf(ref('Comment')), next_cursor: nullable('string'),
        viewer: { type: 'object', properties: { signed_in: { type: 'boolean' }, can_comment: { type: 'boolean' }, can_vote: { type: 'boolean' }, can_moderate: { type: 'boolean' } } },
    } }), ...errors([400, 404, 429]) },
});
route('post', '/api/v1/comments/threads/{id}/comments', {
    operationId: 'addComment', summary: 'Comment on a thread', tags: ['comments'], security: PERSON, parameters: [path('id', str())],
    description: 'community.comment.create. Anonymous visitors may comment on public threads with anon_name.',
    requestBody: body({ type: 'object', required: ['message'], properties: {
        message: str(), parent_id: nullable('integer', { minimum: 1 }), anon_name: str({ maxLength: 32 }),
        attachments: { type: 'array', maxItems: 4, items: ref('AiFile') },
    } }),
    responses: { 201: json('The comment', { type: 'object', properties: { comment: ref('Comment') } }), ...errors() },
});
route('post', '/api/v1/comments/threads/{id}/section-reactions', {
    operationId: 'reactToSection', summary: 'Say whether a section of a post was good', tags: ['comments'], security: PERSON, parameters: [path('id', str())],
    description: 'community.comment.create. One row per person and section: 1 (good), -1 (not good), 0 takes it back. The counts are recomputed from the rows.',
    requestBody: body({ type: 'object', required: ['section_id', 'value'], properties: {
        section_id: str({ maxLength: 64 }), value: { type: 'integer', enum: [1, -1, 0] },
    } }),
    responses: { 200: json('The section\'s counts', { type: 'object', properties: { section_id: str(), value: { type: 'integer' }, upvotes: { type: 'integer' }, downvotes: { type: 'integer' } } }), ...errors() },
});
route('get', '/api/v1/comments/threads/{id}/section-reactions', {
    operationId: 'sectionReactions', summary: 'The counts of every section of a post, and mine', tags: ['comments'], parameters: [path('id', str())],
    description: 'community.comment.read. Anyone may read the counts; a signed-in reader also gets their own reaction per section.',
    responses: { 200: json('Counts by section', { type: 'object' }), ...errors() },
});
route('put', '/api/v1/comments/threads/{id}/visibility', {
    operationId: 'setThreadVisibility', summary: 'Hide or lock a thread (moderators)', tags: ['comments'], security: PERSON, parameters: [path('id', str())],
    description: 'community.comment.moderate.',
    requestBody: body({ type: 'object', required: ['visibility'], properties: { visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] } } }),
    responses: { 200: json('The thread', { type: 'object', properties: { thread: ref('Thread') } }), ...errors() },
});
route('get', '/api/v1/comments/{commentId}', {
    operationId: 'getComment', summary: 'One comment with its replies', tags: ['comments'], security: ANONYMOUS,
    parameters: [path('commentId', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The comment', { type: 'object', properties: { comment: ref('Comment') } }), ...errors([404, 429]) },
});
route('patch', '/api/v1/comments/{commentId}', {
    operationId: 'editComment', summary: 'Edit your comment', tags: ['comments'], security: PERSON,
    parameters: [path('commentId', { type: 'integer', minimum: 1 })],
    description: 'community.comment.edit.',
    requestBody: body({ type: 'object', required: ['message'], properties: { message: str() } }),
    responses: { 200: json('The comment', { type: 'object', properties: { comment: ref('Comment') } }), ...errors() },
});
route('delete', '/api/v1/comments/{commentId}', {
    operationId: 'deleteComment', summary: 'Delete a comment (its author, or a moderator)', tags: ['comments'], security: PERSON,
    parameters: [path('commentId', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The comment, tombstones kept for replies'), ...errors() },
});
route('post', '/api/v1/comments/{commentId}/votes', {
    operationId: 'voteComment', summary: 'Up- or downvote a comment', tags: ['comments'], security: PERSON,
    parameters: [path('commentId', { type: 'integer', minimum: 1 })],
    description: 'community.comment.vote. value 1, -1 or 0 to clear.',
    requestBody: body({ type: 'object', required: ['value'], properties: { value: { type: 'integer', enum: [1, -1, 0] } } }),
    responses: { 200: json('The comment and its score'), ...errors() },
});

// ── /api/v1/pulse — the network's public activity (server/pulse/api.js) ──────────────────────
route('get', '/api/v1/pulse', {
    operationId: 'listPulse', summary: 'The old wall path: the one feed\'s wall view', tags: ['pulse'], security: ANONYMOUS,
    description: 'Kept for clients that still ask /api/v1/pulse; the answer is the same rows and ids as /api/v1/feed/wall (OpenVibe.Network feed.item@1).',
    parameters: [query('after', str(), 'The next_cursor from the previous page'), query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    responses: { 200: json('Items and the cursor for the next page', { type: 'object', properties: { items: arrayOf({ type: 'object' }), next_cursor: nullable('string') } }), ...errors([429]) },
});
route('get', '/api/v1/feed', {
    operationId: 'getFeed', summary: 'The menu\'s Feed: one stream from Pulse, newest first', tags: ['feed'], security: ANONYMOUS,
    description: 'Public. A kind, site or word filters the stream; following=1 is the signed-in person\'s Network follows. Cards carry Community\'s views, likes and comments where it knows them.',
    parameters: [
        query('kind', { type: 'string', enum: ['live', 'stream', 'clip', 'video', 'pic', 'post', 'meme', 'game', 'update', 'wiki', 'quest', 'chat', 'event', 'member', 'avatar', 'banner', 'paste', 'site', 'space', 'follow', 'episode'] }),
        query('site', str({ maxLength: 40 }), 'A source service (live, community, wiki, quest, chat, today, network…)'),
        query('q', str({ maxLength: 80 }), 'Words in the title or text'), query('following', { type: 'string', enum: ['1', 'true'] }),
        query('cursor', str(), 'The next_cursor from the previous page'), query('limit', { type: 'integer', minimum: 1, maximum: 40, default: 20 })],
    responses: { 200: json('Cards and the next cursor', { type: 'object', required: ['items', 'next_cursor'], properties: {
        items: arrayOf({ type: 'object', required: ['id', 'kind', 'url', 'title', 'text', 'site', 'site_name', 'counts'], properties: {
            id: str(), kind: str(), url: str(), title: str({ maxLength: 300 }), text: str({ maxLength: 280 }), at: nullable('string', { format: 'date-time' }),
            site: str(), site_name: str(), media: nullable('object'), counts: { type: 'object' }, starts_at: str({ format: 'date-time' }), group: { type: 'object' }, visibility: { type: 'string', enum: ['followers'] },
            actor: nullable('object', { properties: { name: nullable('string'), avatar: nullable('string') } }) } }),
        next_cursor: nullable('string') } }), ...errors([400, 401, 429]) },
});
route('get', '/api/v1/feed/search', {
    operationId: 'searchFeed', summary: 'Search feed activity by words, person, site, kind and date', tags: ['feed'], security: ANONYMOUS,
    parameters: [query('q', str({ maxLength: 80 }), 'For example, clips from today or a person\'s name'),
        query('cursor', str(), 'The next_cursor from the previous search page'), query('limit', { type: 'integer', minimum: 1, maximum: 40, default: 20 })],
    responses: { 200: json('Matching feed cards', { type: 'object', properties: { items: arrayOf({ type: 'object' }), next_cursor: nullable('string') } }), ...errors([400, 429]) },
});
route('get', '/api/v1/feed/examples', {
    operationId: 'feedSearchExamples', summary: 'Search examples based on current feed items', tags: ['feed'], security: ANONYMOUS,
    responses: { 200: json('Suggested searches', { type: 'object', properties: { examples: arrayOf({ type: 'object', properties: { text: str(), reason: str() } }) } }), ...errors([429]) },
});
route('get', '/api/v1/feed/wall', {
    operationId: 'feedWall', summary: 'The menu\'s wall: the one feed in the older wall shape', tags: ['feed'], security: ANONYMOUS,
    parameters: [query('cursor', str()), query('limit', { type: 'integer', minimum: 1, maximum: 100 })],
    responses: { 200: json('Items and the next cursor', { type: 'object', properties: { items: arrayOf({ type: 'object' }), next_cursor: nullable('string') } }), ...errors([429]) },
});
// ── /api/v1/activity — Community's public rows for Network's collector ──────────────────────
route('get', '/api/v1/activity', {
    operationId: 'publicActivity', summary: 'Public posts, pastes and accepted submissions, newest first', tags: ['feed'], security: ANONYMOUS,
    description: 'The one feed (OpenVibe.Network server/feed/) polls this; only public rows leave, and nothing is stored.',
    parameters: [query('since', str({ format: 'date-time' })), query('limit', { type: 'integer', minimum: 1, maximum: 1000, default: 500 })],
    responses: { 200: json('Public activity rows', { type: 'object', properties: { items: arrayOf({ type: 'object' }), count: { type: 'integer' } } }), ...errors([429]) },
});
route('post', '/api/v1/me/status', {
    operationId: 'postStatus', summary: 'Post a public status to your profile and Pulse', tags: ['pulse'], security: PERSON,
    requestBody: body({ type: 'object', required: ['text'], properties: { text: str({ minLength: 1, maxLength: 500 }), link: str({ format: 'uri' }) } }),
    responses: { 201: json('Status and its opening post id'), ...errors() },
});
route('get', '/api/v1/profiles/{subject}/statuses', {
    operationId: 'profileStatuses', summary: 'A person\'s recent public statuses', tags: ['pulse'], security: ANONYMOUS,
    parameters: [SUBJECT], responses: { 200: json('Recent statuses'), ...errors([400, 429]) },
});

// ── /api/v1/spaces — the forum (server/forum/api.js) ─────────────────────────────────────────
route('get', '/api/v1/spaces', {
    operationId: 'listSpaces', summary: 'The spaces the caller can read, with the board index', tags: ['spaces'], security: ANONYMOUS,
    responses: { 200: json('Spaces and groups', { type: 'object', properties: { spaces: arrayOf(ref('Space')), groups: arrayOf({ type: 'object' }) } }), ...errors([429]) },
});
route('post', '/api/v1/spaces', {
    operationId: 'createSpace', summary: 'Create a forum space (moderators)', tags: ['spaces'], security: PERSON,
    description: 'community.space.create.',
    requestBody: body({ type: 'object', required: ['name'], properties: {
        name: str({ description: '2 to 60 characters' }), slug: str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }),
        description: str({ maxLength: 300 }), visibility: { type: 'string', enum: ['public', 'members', 'staff'], default: 'public' },
        style: { type: 'string', enum: ['feed', 'forum'] }, kind: { type: 'string', enum: ['discussion', 'request', 'roadmap'] },
        position: { type: 'integer' }, group: nullable('string', { description: 'A group slug on the board index' }), parent: nullable('string', { description: 'A parent forum slug' }),
        members_only: { type: 'boolean' },
    } }),
    responses: { 201: json('The space', { type: 'object', properties: { space: ref('Space') } }), ...errors() },
});
route('put', '/api/v1/spaces/{space}/settings', {
    operationId: 'updateSpace', summary: 'Change a space\'s name, description, style, kind, group or parent (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }), 'The space slug')],
    description: 'community.space.configure.',
    requestBody: body({ type: 'object', properties: {
        name: str(), description: str({ maxLength: 300 }), style: { type: 'string', enum: ['feed', 'forum'] },
        position: { type: 'integer' }, kind: { type: 'string', enum: ['discussion', 'request', 'roadmap'] },
        group: nullable('string'), parent: nullable('string'),
    } }),
    responses: { 200: json('The space', { type: 'object', properties: { space: ref('Space') } }), ...errors() },
});
route('get', '/api/v1/spaces/{space}', {
    operationId: 'getSpace', summary: 'One space', tags: ['spaces'], security: ANONYMOUS,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    responses: { 200: json('The space, its categories and moderators', { type: 'object' }), ...errors([404, 429]) },
});
route('get', '/api/v1/spaces/{space}/moderation-log', {
    operationId: 'getModerationLog', summary: 'A space\'s public moderation log (newest 100)', tags: ['spaces'], security: ANONYMOUS,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    description: 'Every moderator action with its rule and reason, in role only (staff, moderator, owner, automatic); never the moderator\'s identity. Public for public spaces; a members-only space keeps it for signed-in members, a staff space for staff.',
    responses: { 200: json('The space and its entries', { type: 'object', properties: {
        space: ref('Space'),
        entries: arrayOf({ type: 'object', properties: {
            id: { type: 'integer' }, action: { type: 'string', enum: ['lock', 'unlock', 'pin', 'unpin', 'hide', 'delete', 'status'] },
            rule: nullable('string', { enum: MODERATION_RULES }), reason: nullable('string', { maxLength: 280 }),
            actor_role: { type: 'string', enum: ['moderator', 'owner', 'staff', 'automatic'] },
            created_at: str({ format: 'date-time' }),
            thread: nullable('object', { properties: { slug: str(), title: str(), url: str() }, description: 'Null when the thread was removed' }),
            post_id: nullable('integer'),
        } }),
    } }), ...errors([401, 404, 429]) },
});
route('get', '/api/v1/spaces/{space}/threads', {
    operationId: 'listThreads', summary: 'A space\'s threads', tags: ['spaces'], security: ANONYMOUS, parameters: [
        path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })),
        query('sort', { type: 'string', enum: ['hot', 'new', 'top', 'active'] }), query('page', { type: 'integer', minimum: 1 }),
        query('limit', { type: 'integer', minimum: 1, maximum: 100 }), query('category', str({ description: 'A category slug' })),
        query('status', str({ description: 'A thread status (request and roadmap spaces)' }))],
    responses: { 200: json('Threads and the page', { type: 'object', properties: { threads: arrayOf(ref('ThreadSummary')), total: { type: 'integer' } } }), ...errors([400, 404, 429]) },
});
route('get', '/api/v1/spaces/{space}/categories', {
    operationId: 'listCategories', summary: 'A space\'s categories', tags: ['spaces'], security: ANONYMOUS,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    responses: { 200: json('Categories', { type: 'object', properties: { categories: arrayOf({ type: 'object' }) } }), ...errors([404, 429]) },
});
route('post', '/api/v1/spaces/{space}/attachments', {
    operationId: 'uploadAttachment', summary: 'Upload an image for a post (multipart)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    description: 'community.attachment.upload. Images only, stored in OpenVibe.Media; at most 4 per post, 8 MB each.',
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } } },
    responses: { 201: json('The attachment', { type: 'object' }), ...errors([413, 415]) },
});
route('put', '/api/v1/spaces/{space}/categories/{category}', {
    operationId: 'putCategory', summary: 'Create or change a category (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('category', str({ pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }))],
    requestBody: body({ type: 'object', required: ['name'], properties: { name: str(), description: str({ maxLength: 200 }), position: { type: 'integer' } } }),
    responses: { 200: json('The category', { type: 'object', properties: { category: { type: 'object' } } }), ...errors() },
});
route('delete', '/api/v1/spaces/{space}/categories/{category}', {
    operationId: 'deleteCategory', summary: 'Delete a category (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('category', str())],
    responses: { 200: json('What was deleted'), ...errors() },
});
route('put', '/api/v1/spaces/{space}/threads/{slug}/category', {
    operationId: 'setThreadCategory', summary: 'Move a thread to another category (its author or a moderator)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', properties: { category: nullable('string', { description: 'A category slug, or null for none' }) } }),
    responses: { 200: json('The thread'), ...errors([404, 429]) },
});
route('put', '/api/v1/spaces/{space}/threads/{slug}/status', {
    operationId: 'setThreadStatus', summary: 'Set a thread\'s status (staff, request and roadmap spaces)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', required: ['status'], properties: {
        status: { type: 'string', enum: ['open', 'planned', 'in_progress', 'done', 'declined', 'paused'] },
        rule: str({ enum: MODERATION_RULES, description: 'The rule applied, if any' }), reason: str({ maxLength: 280 }),
    } }),
    responses: { 200: json('The thread'), ...errors([400, 404, 429]) },
});
route('post', '/api/v1/spaces/{space}/threads/{slug}/crosspost', {
    operationId: 'crosspostThread', summary: 'Post a thread into another space', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    description: 'community.thread.crosspost.',
    requestBody: body({ type: 'object', required: ['to'], properties: { to: str({ description: 'The destination space slug' }) } }),
    responses: { 201: json('The new thread', { type: 'object' }), ...errors([404, 409, 429]) },
});
route('post', '/api/v1/spaces/{space}/threads', {
    operationId: 'createThread', summary: 'Start a thread', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    description: 'community.thread.create.',
    requestBody: body({ type: 'object', required: ['title', 'body'], properties: {
        title: str(), body: str({ description: 'Markdown (body_markdown is the same field under its old name)' }), category: nullable('string'),
        members_only: { type: 'boolean' }, attachments: arrayOf(str({ description: 'media_id values from /attachments' })),
        pastes: arrayOf(str({ description: 'Paste slugs to card' })),
    } }),
    responses: { 201: json('The thread and its opening post', { type: 'object' }), ...errors() },
});
route('get', '/api/v1/spaces/{space}/threads/{slug}', {
    operationId: 'getThreadPosts', summary: 'A thread and one page of posts', tags: ['spaces'], security: ANONYMOUS,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str()), query('page', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The thread, its posts and what the viewer may do', { type: 'object' }), ...errors([404, 429]) },
});
route('delete', '/api/v1/spaces/{space}/threads/{slug}', {
    operationId: 'deleteThread', summary: 'Delete a thread (its author or a moderator)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', properties: { rule: str({ enum: MODERATION_RULES }), reason: str({ maxLength: 280 }) } }, false),
    responses: { 200: json('What was deleted'), ...errors([404, 429]) },
});
route('post', '/api/v1/spaces/{space}/threads/{slug}/posts', {
    operationId: 'replyToThread', summary: 'Reply in a thread', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    description: 'community.post.create.',
    requestBody: body({ type: 'object', required: ['body'], properties: {
        body: str(), attachments: arrayOf(str({ description: 'media_id values from /attachments' })), pastes: arrayOf(str()),
    } }),
    responses: { 201: json('The post', { type: 'object' }), ...errors() },
});
route('post', '/api/v1/spaces/{space}/threads/{slug}/votes', {
    operationId: 'voteThread', summary: 'Up- or downvote a thread', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    description: 'community.thread.vote.',
    requestBody: body({ type: 'object', required: ['value'], properties: { value: { type: 'integer', enum: [1, -1, 0] } } }),
    responses: { 200: json('The thread and its score'), ...errors() },
});
route('put', '/api/v1/spaces/{space}/threads/{slug}/state', {
    operationId: 'moderateThread', summary: 'Pin or lock a thread (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', properties: {
        pinned: { type: 'boolean' }, locked: { type: 'boolean' },
        rule: str({ enum: MODERATION_RULES, description: 'The rule applied, if any' }), reason: str({ maxLength: 280 }),
    } }),
    responses: { 200: json('The thread'), ...errors([400, 404, 429]) },
});
route('put', '/api/v1/spaces/{space}/threads/{slug}/members-only', {
    operationId: 'setThreadMembersOnly', summary: 'Make a thread members-only (its author or a moderator)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', properties: { members_only: { type: 'boolean' }, owner: { type: 'boolean', description: 'The old name of members_only' } } }),
    responses: { 200: json('The thread'), ...errors([404, 429]) },
});
route('put', '/api/v1/spaces/{space}/threads/{slug}/labels', {
    operationId: 'setThreadLabels', summary: 'Set what a thread carries: its content labels (its author or a moderator)', tags: ['spaces'], security: PERSON,
    description: 'Content labels (common.content-labels@1): each reader\'s own choice on openvibe.network shows, blurs or hides a labelled thread in their page. A label never hides a thread for anyone else. A suggestion the author confirms leaves `suggested`.',
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), path('slug', str())],
    requestBody: body({ type: 'object', required: ['labels'], properties: { labels: { type: 'array', items: { type: 'string', enum: ['nudity', 'language', 'graphic', '18+', 'flashing', 'spoilers'] } } } }),
    responses: { 200: json('The thread, with content_labels'), ...errors([400, 403, 404, 429]) },
});
route('put', '/api/v1/spaces/{space}/members-only', {
    operationId: 'setSpaceMembersOnly', summary: 'Make a whole space members-only (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    requestBody: body({ type: 'object', properties: { members_only: { type: 'boolean' }, owner: { type: 'boolean' } } }),
    responses: { 200: json('The space'), ...errors([404, 429]) },
});
route('put', '/api/v1/spaces/{space}/chat-room', {
    operationId: 'attachChatRoom', summary: 'Attach an OpenVibe.Chat room to a space', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    description: 'community.space.configure. created is true on 201 when a room was attached, false on 200 when it was replaced.',
    requestBody: body({ type: 'object', required: ['room'], properties: { room: str({ description: 'The room (id or ref)' }) } }),
    responses: { 200: json('The space and its room', { type: 'object' }), 201: json('The space and its new room', { type: 'object' }), ...errors() },
});
route('delete', '/api/v1/spaces/{space}/chat-room', {
    operationId: 'detachChatRoom', summary: 'Detach the space\'s chat room', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    description: 'community.space.configure.',
    responses: { 200: json('The space'), ...errors([404, 429]) },
});
route('get', '/api/v1/spaces/{space}/moderators', {
    operationId: 'listModerators', summary: 'A space\'s moderators', tags: ['spaces'], security: ANONYMOUS,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' }))],
    responses: { 200: json('The moderators'), ...errors([404, 429]) },
});
route('put', '/api/v1/spaces/{space}/moderators/{subject}', {
    operationId: 'addModerator', summary: 'Add a moderator to a space', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), SUBJECT],
    description: 'community.space.configure. Idempotent.',
    responses: { 200: json('The moderator list'), ...errors([403, 404, 429]) },
});
route('delete', '/api/v1/spaces/{space}/moderators/{subject}', {
    operationId: 'removeModerator', summary: 'Remove a moderator from a space', tags: ['spaces'], security: PERSON,
    parameters: [path('space', str({ pattern: '^[a-z0-9][a-z0-9-]{1,39}$' })), SUBJECT],
    description: 'community.space.configure.',
    responses: { 200: json('The moderator list'), ...errors([403, 404, 429]) },
});

// ── /api/v1/posts — one forum post (server/forum/api.js) ────────────────────────────────────
route('post', '/api/v1/posts', {
    operationId: 'createPost', summary: 'Post a status with pictures and files, in the Feed at once', tags: ['posts'], security: PERSON,
    description: 'People only. Pictures are Media objects the person owns, each with required alt text. Other files are composer attachments from Media; the post is a thread in the Status space. A post with pictures also makes one paste, which opens the post\'s thread: the answer carries the paste\'s address and the thread\'s, and a comment on the post and a comment on the paste are the same comment.',
    requestBody: body({ type: 'object', required: ['text'], properties: {
        text: str({ minLength: 1, maxLength: 2000 }),
        pictures: { type: 'array', maxItems: 4, items: { type: 'object', required: ['media_id', 'alt'], properties: {
            media_id: str({ pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' }), alt: str({ minLength: 1, maxLength: 300 }) } } },
        attachments: { type: 'array', maxItems: 10, items: str({ pattern: '^att_[0-9A-HJKMNP-TV-Z]{26}$' }) } } }),
    responses: { 201: json('The post, its pictures and files'), ...errors([400, 401, 409, 429, 502]) },
});
route('put', '/api/v1/posts/{id}', {
    operationId: 'editPost', summary: 'Edit a post (its author or a moderator)', tags: ['posts'], security: PERSON,
    parameters: [path('id', { type: 'string' })],
    description: 'community.post.edit. Every edit keeps the previous version.',
    requestBody: body({ type: 'object', required: ['body'], properties: { body: str() } }),
    responses: { 200: json('The post'), ...errors([404, 429]) },
});
route('post', '/api/v1/posts/{id}/reactions', {
    operationId: 'reactToPost', summary: 'React to a post', tags: ['posts'], security: PERSON,
    parameters: [path('id', { type: 'string' })],
    description: 'community.post.react. reaction null or empty removes the caller\'s reaction.',
    requestBody: body({ type: 'object', properties: { reaction: nullable('string') } }),
    responses: { 200: json('The post and its reactions'), ...errors([404, 429]) },
});
route('delete', '/api/v1/posts/{id}', {
    operationId: 'deletePost', summary: 'Delete a post (its author or a moderator)', tags: ['posts'], security: PERSON,
    parameters: [path('id', { type: 'string' })],
    description: 'community.post.delete.',
    requestBody: body({ type: 'object', properties: { rule: str({ enum: MODERATION_RULES }), reason: str({ maxLength: 280 }) } }, false),
    responses: { 200: json('What was deleted'), ...errors([404, 429]) },
});
route('get', '/api/v1/posts/{id}/versions', {
    operationId: 'postVersions', summary: 'A post\'s earlier versions (its author or a moderator)', tags: ['posts'], security: PERSON,
    parameters: [path('id', { type: 'string' })],
    responses: { 200: json('Versions'), ...errors([403, 404, 429]) },
});

// ── /api/v1/space-groups — the board index groups (server/forum/api.js) ─────────────────────
route('get', '/api/v1/space-groups', {
    operationId: 'listSpaceGroups', summary: 'The board index groups and the spaces in each', tags: ['spaces'], security: ANONYMOUS,
    responses: { 200: json('Groups', { type: 'object', properties: { groups: arrayOf({ type: 'object' }) } }), ...errors([429]) },
});
route('put', '/api/v1/space-groups/{group}', {
    operationId: 'putSpaceGroup', summary: 'Create or change a group on the board index (moderators)', tags: ['spaces'], security: PERSON,
    parameters: [path('group', str())],
    description: 'community.space.configure.',
    requestBody: body({ type: 'object', required: ['name'], properties: { name: str(), description: nullable('string'), position: { type: 'integer' } } }),
    responses: { 200: json('The group', { type: 'object', properties: { group: { type: 'object' } } }), ...errors() },
});

// ── /api/v1/relay — the Discord relay's administration (server/relay/api.js) ────────────────
route('get', '/api/v1/relay/status', {
    operationId: 'relayStatus', summary: 'The relay queue, the Events worker and the inbound gateway (staff)', tags: ['relay'], security: STAFF,
    responses: { 200: json('Queue by status, cursor and lag, the gateway state'), ...errors([401, 403, 429]) },
});
route('get', '/api/v1/relay/deliveries', {
    operationId: 'relayDeliveries', summary: 'What was sent, what is failing and why (staff)', tags: ['relay'], security: STAFF, parameters: [
        query('status', { type: 'string', enum: ['pending', 'delivered', 'failed', 'dropped', 'skipped'] }),
        query('action', { type: 'string', enum: ['create', 'edit', 'delete'] }), query('limit', { type: 'integer', minimum: 1 })],
    responses: { 200: json('Deliveries'), ...errors([400, 401, 403, 429]) },
});
route('post', '/api/v1/relay/deliveries/{id}/retry', {
    operationId: 'retryDelivery', summary: 'Queue a delivery again, with a fresh attempt budget (staff)', tags: ['relay'], security: STAFF,
    parameters: [path('id', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The delivery'), ...errors([401, 403, 404, 429]) },
});
route('post', '/api/v1/relay/deliveries/{id}/drop', {
    operationId: 'dropDelivery', summary: 'Give up on a waiting or failed delivery (staff)', tags: ['relay'], security: STAFF,
    parameters: [path('id', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The delivery'), ...errors([401, 403, 404, 429]) },
});
route('get', '/api/v1/relay/inbound', {
    operationId: 'relayInbound', summary: 'Discord messages that did not become posts, and why (staff)', tags: ['relay'], security: STAFF,
    parameters: [query('all', { type: 'string', enum: ['1'] }), query('limit', { type: 'integer', minimum: 1 })],
    responses: { 200: json('Inbound messages'), ...errors([401, 403, 429]) },
});
route('post', '/api/v1/relay/inbound/{id}/dismiss', {
    operationId: 'dismissInbound', summary: 'Mark one inbound message seen (staff)', tags: ['relay'], security: STAFF,
    parameters: [path('id', { type: 'integer', minimum: 1 })],
    responses: { 200: json('The message'), ...errors([401, 403, 404, 429]) },
});
route('get', '/api/v1/relay/mappings', {
    operationId: 'relayMappings', summary: 'Space to Discord channel mappings (staff)', tags: ['relay'], security: STAFF,
    description: 'Webhook URLs and the bot token never leave the environment: only variable names and whether they are set.',
    responses: { 200: json('{ enabled, mappings }'), ...errors([401, 403, 429]) },
});
route('post', '/api/v1/relay/mappings', {
    operationId: 'addRelayMapping', summary: 'Map a space to a Discord channel (staff)', tags: ['relay'], security: STAFF,
    description: 'The webhook URL stays in the environment: webhook_url_ref is an allow-listed variable name.',
    requestBody: body({ type: 'object', required: ['space', 'webhook_url_ref'], properties: {
        space: str(), webhook_url_ref: str(), enabled: { type: 'boolean' }, discord_channel_id: str(), discord_thread_id: str(), inbound: { type: 'boolean' },
    } }),
    responses: { 200: json('The mapping'), ...errors([400, 401, 403, 404, 409, 429]) },
});
route('put', '/api/v1/relay/mappings/{id}', {
    operationId: 'updateRelayMapping', summary: 'Change a mapping (staff)', tags: ['relay'], security: STAFF,
    parameters: [path('id', { type: 'integer', minimum: 1 })],
    requestBody: body({ type: 'object', properties: { enabled: { type: 'boolean' }, inbound: { type: 'boolean' }, discord_channel_id: str(), discord_thread_id: str() } }),
    responses: { 200: json('The mapping'), ...errors([400, 401, 403, 404, 429]) },
});

// ── /api/v1/resources — the authority index for OpenVibe.Services (server/registry) ─────────
route('post', '/api/v1/resources/control', {
    operationId: 'controlOwnedResource', summary: 'Delete one of a person\'s pastes (OpenVibe.Services)', tags: ['resources'], security: SERVICE,
    description: 'community.resource.control. One common.owned-resource-control-request@1; a paste takes delete, and the result is 200 for every outcome (without resource).',
    requestBody: body({ type: 'object', required: ['owned', 'owner', 'action', 'idempotency_key'], properties: {
        owned: { type: 'object', properties: { kind: str({ description: 'community.paste' }), id: str({ description: 'The paste slug' }) } },
        owner: { type: 'object', properties: { type: str(), id: str() } },
        action: { type: 'string', enum: ['delete'] }, dry_run: { type: 'boolean' }, idempotency_key: str(),
    } }),
    responses: { 200: json('common.resource-control-result@1: action, state, at, and result or problem'), ...errors([400, 401, 403, 409]) },
});
route('get', '/api/v1/resources', {
    operationId: 'listResources', summary: 'A person\'s pastes and spaces (OpenVibe.Services, loopback only)', tags: ['resources'], security: SERVICE,
    description: 'community.resource.read. common.resource-list-result@1; person-owned only.',
    parameters: [query('kind', { type: 'string', enum: ['community.paste', 'community.space'] }),
        query('owner', str({ pattern: '^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$' })), query('project', str({ pattern: '^prj_[0-9A-HJKMNP-TV-Z]{26}$' }), 'Always an empty page: nothing here belongs to a project'),
        query('cursor', str()), query('limit', { type: 'integer', minimum: 1, maximum: 1000 })],
    responses: { 200: json('common.resource-list-result@1: items and next_cursor'), ...errors([400, 401, 403]) },
});
route('get', '/api/v1/resources/{ovrn}', {
    operationId: 'getResource', summary: 'Nothing here has an OVRN (404 for every name)', tags: ['resources'], security: SERVICE,
    parameters: [path('ovrn', str())],
    description: 'community.resource.read: pastes and spaces are person-owned, so their OVRN resolves to 404.',
    responses: { 404: problem },
});

function openapi() {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Community API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'MIT', identifier: 'MIT' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Community', email: 'contact@openvibe.network' },
        },
        servers: [{ url: SITE }],
        // The uniform share API is served by openvibe-sdk/share's router (not a route Express lists in
        // its stack), so it is described here rather than under paths. docs/sharing.md has the page.
        'x-sharing': {
            description: 'One audience per paste and a transfer, chosen by its owner. Every read (page, raw, download, screenshot, JSON, comments, previews) asks the same canView check; people and private pastes are never listed, indexed, embedded or previewed with their title, description or picture.',
            audiences: ['public', 'link', 'people', 'private'],
            routes: [
                'GET|PUT /api/v1/paste/{slug}/share',
                'POST /api/v1/paste/{slug}/share/requests',
                'POST /api/v1/paste/{slug}/share/requests/{id}/dismiss',
                'POST /api/v1/paste/{slug}/share/transfer',
                'POST /api/v1/paste/{slug}/share/transfer/{accept,decline,cancel}',
                'GET /api/v1/share/people?name=',
                'GET /api/v1/shared-with-me',
            ],
            createWithSharing: {
                request: { content: 'the notes', audience: 'people', members: ['@maticus'], transfer_to: '@maticus', keep_access: false },
                curl: `curl -X POST ${SITE}/api/pastes -H 'Authorization: Bearer $TOKEN' -H 'Content-Type: application/json' -d '{"content":"the notes","audience":"people","members":["@maticus"],"transfer_to":"@maticus","keep_access":false}'`,
            },
            docs: `${SITE}/docs/sharing`,
        },
        tags: ['pastes', 'pastes-admin', 'submissions', 'comments', 'pulse', 'spaces', 'posts', 'relay', 'resources'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network user JWT (people) or a service token for audience openvibe.community carrying the route\'s capability, acting for the person named in X-OV-Subject' },
                cookie: { type: 'apiKey', in: 'cookie', name: 'ov_token', description: 'The browser session: the same Network user JWT as a host-only cookie' },
            },
            schemas: {
                Paste: { type: 'object', required: ['slug', 'type', 'visibility'], properties: {
                    id: { type: 'integer' }, app_id: { const: 'community' }, slug: str(), user_id: nullable('string'), owner_subject: nullable('string'),
                    origin: str(), type: { type: 'string', enum: ['paste', 'screenshot'] }, title: nullable('string'), content: nullable('string'),
                    language: nullable('string'), visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
                    locked: { type: 'boolean', description: 'A Locker paste: content is null and envelope_url serves the bytes' },
                    lock: nullable('string', { enum: ['people', 'password', 'link'] }),
                    title_shown: { type: 'boolean', description: 'A locked paste whose title is outside its envelope' },
                    envelope_url: nullable('string', { description: 'A locked paste only: /p/{slug}/raw, application/octet-stream' }),
                    stream_id: nullable('string'), stream_ref: nullable('object'), screenshot_url: nullable('string'),
                    burn_after_read: { type: 'boolean' }, forked_from: nullable('string'), pinned: { type: 'boolean' },
                    views: { type: 'integer' }, unique_views: { type: 'integer' }, copies: { type: 'integer' }, likes: { type: 'integer' },
                    is_nsfw: { type: 'boolean' }, metadata: nullable('object'),
                } },
                PasteComment: { type: 'object', properties: {
                    id: { type: 'integer' }, paste_id: { type: 'integer' }, user_id: nullable('string'), author_subject: nullable('string'),
                    parent_id: nullable('integer'), anon_name: nullable('string'), message: nullable('string'), is_deleted: { type: 'integer', enum: [0, 1] },
                    created_at: str(), updated_at: str(), replies: arrayOf({ type: 'object' }), reply_count: { type: 'integer' },
                } },
                Submission: { type: 'object', required: ['slug', 'kind', 'status'], properties: {
                    slug: str(), kind: { type: 'string', enum: ['clip', 'art', 'idea', 'report'] }, title: str(), body: nullable('string'),
                    url: nullable('string'), media_ref: nullable('string'),
                    status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'withdrawn'] },
                    author: { type: 'object' }, reviewer: nullable('object'), review_note: nullable('string', { description: 'The author and moderators only' }),
                    reviewed_at: nullable('string', { format: 'date-time' }), created_at: str({ format: 'date-time' }), updated_at: str({ format: 'date-time' }),
                    page_url: str(), can: { type: 'object', properties: { withdraw: { type: 'boolean' }, review: { type: 'boolean' } } },
                } },
                PulseItem: { type: 'object', properties: {
                    id: { type: 'integer' }, source: { type: 'object', properties: { service: str(), type: str(), id: str() } }, title: str(), url: str(),
                    origin: { type: 'string', enum: ['user', 'ai', 'system'] }, occurred_at: str({ format: 'date-time' }), actor: nullable('object'),
                    label: nullable('string'), via: str(), picture_url: str({ format: 'uri' }),
                } },
                Thread: { type: 'object', required: ['id', 'visibility'], properties: {
                    id: str(), access_id: str(), ref: { type: 'object' }, visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
                    comment_count: nullable('integer'), created_at: str(), updated_at: str(),
                } },
                ThreadSummary: { type: 'object', properties: {
                    slug: str(), title: str(), author: nullable('object'), status: nullable('string'), pinned: { type: 'boolean' },
                    locked: { type: 'boolean' }, category: nullable('string'), score: { type: 'integer' }, reply_count: { type: 'integer' },
                    last_activity_at: nullable('string', { format: 'date-time' }), created_at: str({ format: 'date-time' }),
                } },
                Comment: { type: 'object', required: ['id', 'message'], properties: {
                    id: { type: 'integer' }, thread_id: str(), parent_id: nullable('integer'), reply_to_id: nullable('integer'),
                    reply_to: nullable('object', { description: 'The exact comment answered, with its author display name' }), origin: str(), author: nullable('object'),
                    anon_name: nullable('string'), display_name: nullable('string'), message: nullable('string'), deleted: { type: 'boolean' },
                    score: { type: 'integer' }, upvotes: { type: 'integer' }, downvotes: { type: 'integer' }, my_vote: { type: 'integer' },
                    created_at: str(), updated_at: str(), replies: arrayOf({ type: 'object' }), attachments: arrayOf(ref('AiFile')),
                } },
                AiFile: { type: 'object', required: ['id', 'name', 'media_type', 'size', 'storage', 'access', 'read'], properties: {
                    id: { type: 'string', pattern: '^med_[0-9A-HJKMNP-TV-Z]{26}$' }, name: str(), media_type: str(), size: { type: 'integer', minimum: 0 },
                    storage: { type: 'object', required: ['provider', 'key'], properties: { provider: { const: 'media' }, key: str() } },
                    access: { type: 'object', required: ['readers'], properties: { readers: arrayOf(str()) } },
                    read: { type: 'object', required: ['method'], properties: { method: { type: 'string', enum: ['text', 'pages', 'image', 'audio_transcript', 'not_readable'] }, content: str(), pages: arrayOf(str()), reason: str() } },
                    role: { type: 'string', enum: ['input', 'artifact'] },
                } },
                Space: { type: 'object', required: ['slug', 'name'], properties: {
                    slug: str(), name: str(), description: nullable('string'), visibility: { type: 'string', enum: ['public', 'members', 'staff'] },
                    style: { type: 'string', enum: ['feed', 'forum'] }, kind: { type: 'string', enum: ['discussion', 'request', 'roadmap'] },
                    position: { type: 'integer' }, group: nullable('string'), parent: nullable('string'), members_only: { type: 'boolean' },
                    thread_count: { type: 'integer' }, post_count: { type: 'integer' },
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b))) },
    };
}

/** The documented routes as "METHOD /path": what the app must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${p}`)).sort();
}

/** Serve GET /openapi.json here; GET /api/v1/openapi.json redirects to it (308). */
function mount(app, document = openapi()) {
    const send = (_req, res) => {
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount };
