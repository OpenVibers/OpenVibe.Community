'use strict';

const assert = require('node:assert/strict');
const { cleanReference, publicReference } = require('../server/comments/attachments');
const { createCommentsApi } = require('../server/comments/api');
const { commentPanel } = require('../server/render/comments');

const SUBJECT = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ID = 'med_01JAB2C3D4E5F6G7H8J9K0MNP6';

const input = { id: ID, name: 'look.png', media_type: 'image/png', size: 12,
    storage: { provider: 'media', key: ID }, access: { readers: [SUBJECT] },
    read: { method: 'not_readable', reason: 'Attached; open the comment to read it.' }, role: 'input' };
assert.deepEqual(cleanReference(input, SUBJECT), input);
assert.throws(() => cleanReference({ ...input, storage: { provider: 'media', key: 'different' } }, SUBJECT), { code: 'comment.attachment_invalid' });
const output = publicReference({ media_id: ID, filename: 'look.png', mime: 'image/png', size_bytes: 12, owner_subject: SUBJECT });
assert.deepEqual(Object.keys(output).sort(), Object.keys(input).sort());
assert.equal(output.id, input.id);
assert.equal(output.storage.key, input.storage.key);
const html = commentPanel({ page: { thread: { ref: { service: 'community', type: 'paste', id: 'paste-1' }, comment_count: 1 },
    comments: [{ id: 1, message: 'Picture', created_at: null, author: { display_name: 'Owner' }, attachments: [output] }],
    viewer: { can_comment: false } }, user: null, base: '/p/paste-1' });
assert.ok(html.includes(`<img src="https://openvibe.media/o/${ID}" alt="look.png" loading="lazy" width="120">`));
assert.ok(html.includes('rel="noopener noreferrer"'));
assert.equal(typeof createCommentsApi, 'function');
