'use strict';
/**
 * A comment carries a Media composer attachment (composer.attachment@1): the person names a file Media stored
 * for them (a video, a picture) and Community asks Media whether it exists, is theirs and may be carried, keeps
 * it with the comment, and answers what plays it. The old file upload path is untouched.
 */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0 }, appOpts: { commentLimits: { comments: { cooldownSec: 0, perMinute: 1000 } } } });
    const net = t.network;
    const { namedAttachments } = require('../server/comments/form');
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });

    const call = (path, { method = 'GET', token, cookie, headers = {}, json, body } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const slug = (await t.app.locals.pastes.createText({ kind: 'user', subject: alex.subject_id, origin: 'user' }, { content: 'a comment with a video', visibility: 'public' })).slug;
    const ref = { service: 'community', type: 'paste', id: slug };
    const thread = (await call('/api/v1/comments/threads/resolve', { method: 'POST', json: { ref } })).json().thread;
    const post = (json, who = {}) => call(`/api/v1/comments/threads/${thread.id}/comments`, { method: 'POST', json, ...who });

    const videoId = `att_${ids.ulid()}`;
    t.media.addAttachment({
        id: videoId, subject: alex.subject_id, kind: 'video', name: '7224.mp4', mime: 'video/mp4', size: 24819344,
        url: `https://openvibe.media/a/${videoId}/7224.mp4`,
        poster: `https://openvibe.media/a/${videoId}/thumb.jpg`,
        playback: { url: `https://openvibe.media/a/${videoId}/playback.mp4`, mime: 'video/mp4', ready: true },
        duration_s: 73.4, width: 1920, height: 1080,
    });

    await check('the form field is read as a list of Media attachments', () => {
        const one = 'att_' + ids.ulid();
        assert.deepStrictEqual(namedAttachments(JSON.stringify([{ media_attachment_id: one }])), [{ media_attachment_id: one }]);
        assert.deepStrictEqual(namedAttachments(''), []);
        assert.deepStrictEqual(namedAttachments(undefined), []);
        assert.throws(() => namedAttachments('not json'), { status: 400, code: 'comment.attachment_invalid' });
    });

    await check('a video named by its id is kept with the comment and answered with what plays it', async () => {
        const r = await post({ message: 'here it is', attachments: [{ media_attachment_id: videoId }] }, { cookie: alexJwt });
        assert.strictEqual(r.status, 201, r.text);
        const c = r.json().comment;
        const a = c.attachments[0];
        assert.strictEqual(a.id, videoId);
        assert.strictEqual(a.kind, 'video');
        assert.strictEqual(a.media_type, 'video/mp4');
        assert.strictEqual(a.size, 24819344);
        assert.deepStrictEqual(a.playback, { url: `https://openvibe.media/a/${videoId}/playback.mp4`, mime: 'video/mp4', ready: true });
        assert.strictEqual(a.poster, `https://openvibe.media/a/${videoId}/thumb.jpg`);
        assert.strictEqual(a.duration_s, 73.4);
        assert.deepStrictEqual([a.width, a.height], [1920, 1080]);
        const keep = t.media.keeps.find((k) => k.id === videoId);
        assert.ok(keep, 'Media was asked to keep the attachment');
        assert.strictEqual(keep.subject, alex.subject_id);
        assert.strictEqual(keep.message_id, String(c.id), 'it is kept with the comment');
        const row = await t.db.prepare('SELECT * FROM comment_attachments WHERE media_id = ?').get(videoId);
        assert.strictEqual(row.kind, 'video');
        assert.strictEqual(row.comment_id, c.id);
    });

    await check('another person\'s attachment is refused, exactly like one that does not exist', async () => {
        const other = await post({ message: 'not mine', attachments: [{ media_attachment_id: videoId }] }, { cookie: samJwt });
        assert.strictEqual(other.status, 404, other.text);
        const missing = await post({ message: 'nobody\'s', attachments: [{ media_attachment_id: `att_${ids.ulid()}` }] }, { cookie: alexJwt });
        assert.strictEqual(missing.status, 404, missing.text);
        assert.strictEqual(missing.json().code, other.json().code, 'the same answer either way');
    });

    await check('an executable is refused', async () => {
        const codeId = `att_${ids.ulid()}`;
        t.media.addAttachment({ id: codeId, subject: alex.subject_id, kind: 'code', name: 'run.sh', mime: 'text/x-sh', size: 12 });
        const r = await post({ message: 'no', attachments: [{ media_attachment_id: codeId }] }, { cookie: alexJwt });
        assert.strictEqual(r.status, 415, r.text);
        assert.strictEqual(r.json().code, 'comment.attachment_type');
    });

    await check('at most four files on a comment', async () => {
        const five = [0, 1, 2, 3, 4].map(() => {
            const id = `att_${ids.ulid()}`;
            t.media.addAttachment({ id, subject: alex.subject_id, kind: 'image', name: 'a.png', mime: 'image/png', size: 3 });
            return id;
        });
        const r = await post({ message: 'many', attachments: five.map((id) => ({ media_attachment_id: id })) }, { cookie: alexJwt });
        assert.strictEqual(r.status, 400, r.text);
        assert.strictEqual(r.json().code, 'comment.attachments_too_many');
    });

    await check('the old file upload still works', async () => {
        const form = new FormData();
        form.set('ref', JSON.stringify(ref));
        form.set('file', new Blob([Buffer.from('picture bytes')], { type: 'image/png' }), 'look.png');
        const uploaded = await t.get('/api/v1/comments/attachments', { method: 'POST', headers: { authorization: `Bearer ${alexJwt}` }, body: form });
        assert.strictEqual(uploaded.status, 201, uploaded.text);
        const attachment = uploaded.json().attachment;
        assert.strictEqual(attachment.name, 'look.png');
        const r = await post({ message: 'with picture', attachments: [attachment] }, { cookie: alexJwt });
        assert.strictEqual(r.status, 201, r.text);
        const a = r.json().comment.attachments[0];
        assert.strictEqual(a.id, attachment.id);
        assert.strictEqual(a.kind, 'image');
        assert.strictEqual(a.playback, null);
    });

    await check('the no-JS form may name the attachment too', async () => {
        const formId = `att_${ids.ulid()}`;
        t.media.addAttachment({ id: formId, subject: alex.subject_id, kind: 'image', name: 'form.png', mime: 'image/png', size: 3,
            url: `https://openvibe.media/a/${formId}/form.png` });
        const form = new FormData();
        form.set('message', 'from the form');
        form.set('attachments', JSON.stringify([{ media_attachment_id: formId }]));
        const r = await t.get(`/c/${thread.id}`, { method: 'POST', body: form, cookies: [`ov_token=${alexJwt}`] });
        assert.strictEqual(r.status, 303, r.text);
        const page = await t.get(`/c/${thread.id}`);
        assert.ok(page.text.includes('from the form'), 'the comment is there');
    });

    await check("Shared's composer form: one plain att_ id per file, repeated", async () => {
        const one = `att_${ids.ulid()}`, two = `att_${ids.ulid()}`;
        assert.deepStrictEqual(namedAttachments(one), [{ media_attachment_id: one }]);
        assert.deepStrictEqual(namedAttachments([one, two]), [{ media_attachment_id: one }, { media_attachment_id: two }]);
        assert.deepStrictEqual(namedAttachments([JSON.stringify({ media_attachment_id: two })]), [{ media_attachment_id: two }]);
        t.media.addAttachment({ id: one, subject: alex.subject_id, kind: 'image', name: 'a.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${one}/a.png` });
        t.media.addAttachment({ id: two, subject: alex.subject_id, kind: 'image', name: 'b.png', mime: 'image/png', size: 3, url: `https://openvibe.media/a/${two}/b.png` });
        const form = new FormData();
        form.set('message', 'two pictures');
        form.append('attachments', one);
        form.append('attachments', two);
        const r = await t.get(`/c/${thread.id}`, { method: 'POST', body: form, cookies: [`ov_token=${alexJwt}`] });
        assert.strictEqual(r.status, 303, r.text);
        const listed = (await call(`/api/v1/comments/threads/${thread.id}?sort=new`)).json();
        const c = listed.comments.find((x) => x.message === 'two pictures');
        assert.ok(c, 'the comment is there');
        assert.deepStrictEqual(c.attachments.map((a) => a.id).sort(), [one, two].sort());
    });

    await check('a video whose web copy was still being made plays once Media says it is ready', async () => {
        const slow = `att_${ids.ulid()}`;
        const media = t.media.addAttachment({
            id: slow, subject: alex.subject_id, kind: 'video', name: 'clip.mkv', mime: 'video/x-matroska', size: 900,
            url: `https://openvibe.media/a/${slow}/clip.mkv`, poster: `https://openvibe.media/a/${slow}/thumb.jpg`,
            playback: { url: `https://openvibe.media/a/${slow}/clip.mkv`, mime: 'video/x-matroska', ready: false },
        });
        const r = await post({ message: 'still copying', attachments: [{ media_attachment_id: slow }] }, { cookie: alexJwt });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.json().comment.attachments[0].playback.ready, false);
        // Media finishes the copy.
        media.playback = { url: `https://openvibe.media/a/${slow}/playback.mp4`, mime: 'video/mp4', ready: true };
        const listed = (await call(`/api/v1/comments/threads/${thread.id}?sort=new`)).json();
        const a = listed.comments.find((x) => x.message === 'still copying').attachments[0];
        assert.deepStrictEqual(a.playback, { url: `https://openvibe.media/a/${slow}/playback.mp4`, mime: 'video/mp4', ready: true });
        const row = await t.db.prepare('SELECT playback_ready, playback_url FROM comment_attachments WHERE media_id = ?').get(slow);
        assert.strictEqual(Number(row.playback_ready), 1, 'kept, so the next read does not ask again');
        assert.strictEqual(row.playback_url, `https://openvibe.media/a/${slow}/playback.mp4`);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
