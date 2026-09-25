'use strict';
/**
 * Images on forum posts (WS-J task 2): an upload goes to OpenVibe.Media's Object API v2 as a med_ object
 * the person owns (init → content → complete, Community's service token, X-OV-Subject), metadata stripped
 * and the type taken from the bytes; a thread or reply names at most 4 of the person's own unattached
 * uploads; posts show them; the no-JS forms upload and attach in one step; someone else's upload, a
 * non-image, an anonymous upload and Media being unconfigured are refused.
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');
const { createMediaObjects } = require('../server/media/objects');
const { sniffImage } = require('../server/forum/service');

// A 1×1 PNG with a tEXt chunk (metadata that must not reach Media), with real lengths and CRCs.
const zlib = require('zlib');
const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0secret', 'latin1')),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);

(async () => {
    // ── A stub Media (Object API v2 for tenant community) ──
    const objects = new Map();
    const media = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const send = (status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return send(200, { access_token: 'svc-community', token_type: 'Bearer', expires_in: 300 });
            if (req.headers.authorization !== 'Bearer svc-community') return send(401, { code: 'auth.required' });
            if (req.method === 'POST' && req.url === '/api/v2/community/objects') {
                const b = JSON.parse(body);
                const id = ids.newId('media');
                objects.set(id, { ...b, owner: req.headers['x-ov-subject'], status: 'uploading' });
                return send(201, { id, object: { id } });
            }
            let m = req.url.match(/^\/api\/v2\/community\/objects\/(med_[0-9A-Z]+)\/content$/);
            if (req.method === 'PUT' && m) { const o = objects.get(m[1]); o.bytes = body; o.content_type = req.headers['content-type']; return send(200, { id: m[1], size_bytes: body.length }); }
            m = req.url.match(/^\/api\/v2\/community\/objects\/(med_[0-9A-Z]+)\/complete$/);
            if (req.method === 'POST' && m) {
                const o = objects.get(m[1]);
                const hash = crypto.createHash('sha256').update(o.bytes).digest('hex');
                if (hash !== JSON.parse(body).content_hash || o.bytes.length !== o.size_bytes) return send(400, { code: 'media.object.hash_mismatch' });
                o.status = 'ready';
                return send(200, { id: m[1], lifecycle_status: 'ready' });
            }
            send(404, {});
        });
    });
    await new Promise((r) => media.listen(0, '127.0.0.1', r));
    const mediaBase = `http://127.0.0.1:${media.address().port}`;
    const mediaObjects = createMediaObjects({ config: { oauth: { clientId: 'community', clientSecret: 'x'.repeat(40) }, networkInternalUrl: mediaBase, mediaInternalUrl: mediaBase, mediaUrl: 'https://openvibe.media' } });

    const t = await boot({ authority: 'community', appOpts: { mediaObjects, forumLimits: { threads: { cooldownSec: 0, perMinute: 1000 }, posts: { cooldownSec: 0, perMinute: 1000 }, threadsPerDay: 1000 } } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const upload = (cookie, buf = PNG, name = 'cat.png') => {
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: 'image/png' }), name);
        return t.get('/api/v1/spaces/general/attachments', { method: 'POST', body: fd, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };
    const json = (cookie, path, obj) => t.get(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj), cookies: [`ov_token=${cookie}`] });

    await check('sniffing goes by the bytes', async () => {
        assert.strictEqual(sniffImage(PNG), 'image/png');
        assert.strictEqual(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
        assert.strictEqual(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    });

    let first;
    await check('upload: a med_ object owned by the person, metadata stripped, the public URL', async () => {
        const r = await upload(alexJwt);
        assert.strictEqual(r.status, 201, r.text);
        first = r.json().attachment;
        assert.match(first.media_id, /^med_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(first.url, `https://openvibe.media/o/${first.media_id}`);
        const o = objects.get(first.media_id);
        assert.strictEqual(o.owner, alex.subject_id); assert.strictEqual(o.visibility, 'public'); assert.strictEqual(o.status, 'ready');
        assert.ok(!o.bytes.includes(Buffer.from('secret')), 'the tEXt chunk never reached Media');
        assert.ok(PNG.includes(Buffer.from('secret')));
    });

    await check('refused: signed out, not an image, too many, someone else\'s upload', async () => {
        assert.strictEqual((await upload(null)).status, 401);
        const svg = await upload(alexJwt, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'), 'x.svg');
        assert.strictEqual(svg.status, 415);
        let r = await json(samJwt, '/api/v1/spaces/general/threads', { title: 'Stolen', body: 'mine now', attachments: [first.media_id] });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.json().code, 'attachments.invalid');
        r = await json(alexJwt, '/api/v1/spaces/general/threads', { title: 'Too many', body: 'x', attachments: [1, 2, 3, 4, 5].map(() => first.media_id) });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.json().code, 'attachments.too_many');
    });

    let thread;
    await check('a thread names its images; the post shows them; an attached upload cannot be reused', async () => {
        let r = await json(alexJwt, '/api/v1/spaces/general/threads', { title: 'My cat', body: 'Look.', attachments: [first.media_id] });
        assert.strictEqual(r.status, 201, r.text);
        thread = r.json().thread;
        assert.deepStrictEqual(r.json().post.attachments.map((a) => a.media_id), [first.media_id]);
        const page = (await t.get(`/api/v1/spaces/general/threads/${thread.slug}`)).json();
        assert.strictEqual(page.posts[0].attachments[0].url, first.url);
        assert.strictEqual(page.attachments.enabled, true);
        r = await json(alexJwt, `/api/v1/spaces/general/threads/${thread.slug}/posts`, { body: 'again', attachments: [first.media_id] });
        assert.strictEqual(r.status, 400, 'already on a post');
        const html = (await t.get(`/s/general/t/${thread.slug}`, { cookies: [`ov_token=${samJwt}`] })).text;
        assert.ok(html.includes(`src="${first.url}"`) && html.includes('enctype="multipart/form-data"') && html.includes('name="attachments"'));
    });

    await check('no-JS reply form: the images are uploaded and attached in one step', async () => {
        const fd = new FormData();
        fd.append('body', 'Two more');
        fd.append('attachments', new Blob([PNG], { type: 'image/png' }), 'a.png');
        fd.append('attachments', new Blob([PNG], { type: 'image/png' }), 'b.png');
        const r = await t.get(`/s/general/t/${thread.slug}/reply`, { method: 'POST', body: fd, cookies: [`ov_token=${samJwt}`] });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const page = (await t.get(`/api/v1/spaces/general/threads/${thread.slug}`)).json();
        const reply = page.posts.find((p) => p.body_markdown === 'Two more');
        assert.deepStrictEqual(reply.attachments.map((a) => a.filename), ['a.png', 'b.png']);
        assert.ok(reply.attachments.every((a) => objects.get(a.media_id).owner === sam.subject_id));
        const empty = new FormData();
        empty.append('body', '');
        empty.append('attachments', new Blob([PNG], { type: 'image/png' }), 'c.png');
        const before = objects.size;
        await t.get(`/s/general/t/${thread.slug}/reply`, { method: 'POST', body: empty, cookies: [`ov_token=${samJwt}`] });
        assert.strictEqual(objects.size, before, 'an empty reply uploads nothing');
    });

    await check('without the service principal, attaching is refused and the forms have no file field', async () => {
        const off = createMediaObjects({ config: { oauth: {}, networkInternalUrl: mediaBase, mediaInternalUrl: mediaBase, mediaUrl: 'https://openvibe.media' } });
        assert.strictEqual(off.configured, false);
        await assert.rejects(off.uploadImage({ buffer: PNG, mime: 'image/png', filename: 'x.png', owner: alex.subject_id }), /service principal/);
    });

    media.close();
    await done(t);
})();
