'use strict';
// Community's comment panel asks Shared for Media attachments (plan §Z.9): with Shared 4.247.0 or later the box is
// marked data-ovc-media and takes any video at Media's limits; its form posts the ids in `attachments`, which
// server/comments/form.js reads. With an older Shared the option is ignored and the box is as it was.
const assert = require('node:assert/strict');
const { commentPanel } = require('../server/render/comments');
const shared = require('openvibe-shared/package.json');

const [major, minor] = String(shared.version).split('.').map(Number);
const page = { thread: { id: 'cth_x', access_id: 'cth_x', ref: { service: 'community', type: 'paste', id: 'abc' } }, comments: [], viewer: { can_comment: true } };
const html = commentPanel({ page, user: { username: 'kim' }, base: '/c/cth_x' });
if (major > 4 || (major === 4 && minor >= 247)) {
    assert.match(html, /data-ovc-media="1"/, 'the box sends its files to Media');
    assert.match(html, /accept="image\/\*,video\/\*,audio\/\*/, 'any video, picture or sound');
    const noFiles = commentPanel({ page: { ...page, thread: { ...page.thread, ref: { service: 'video', type: 'video', id: 'v' } } }, user: { username: 'kim' }, base: '/c/cth_x' });
    assert.doesNotMatch(noFiles, /data-ovc-media/, 'a thread without files has no Media box');
    console.log(`comment-panel-media: the box sends its files to Media (Shared ${shared.version})`);
} else {
    assert.doesNotMatch(html, /data-ovc-media/);
    console.log(`comment-panel-media: Shared ${shared.version} has no Media box yet; the option waits for 4.247.0`);
}
