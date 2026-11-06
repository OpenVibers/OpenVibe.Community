'use strict';
// VIS-6 in Community: an image paste is sorted into exactly three categories by Vision, and each one acts.
//   fine          the paste keeps its visibility and serves
//   sex_acts      private + NSFW: gone from every public list and from an anonymous page, kept for its owner
//   minor_sexual  private + quarantined with the operator report id; the owner still sees it, nobody else does
// A Vision outage makes the paste private and pending, never public.
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { boot, check, done } = require('./helpers/app');
const { createPasteReview } = require('../server/pastes/review');

const PNG = (() => {
    const zlib = require('zlib');
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
})();

(async () => {
    // ── Vision stand-in: a token, then one category for the next review ──
    const state = { category: 'fine', fail: false, requests: [] };
    const vision = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return send(200, { access_token: 'svc-vision', token_type: 'Bearer', expires_in: 300 });
            if (req.url === '/api/v1/review') {
                state.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                if (state.fail) return send(503, { code: 'vision.review_unavailable' });
                return send(201, {
                    category: state.category,
                    action: state.category === 'fine' ? 'allow' : state.category === 'sex_acts' ? 'hide' : 'quarantine_and_report',
                    public: state.category === 'fine',
                    report: state.category === 'minor_sexual' ? { id: 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ', status: 'open' } : null,
                });
            }
            send(404, {});
        });
    });
    await new Promise((r) => vision.listen(0, '127.0.0.1', r));
    const visionBase = `http://127.0.0.1:${vision.address().port}`;
    const review = createPasteReview({
        config: { vision: { url: visionBase }, oauth: { clientId: 'community', clientSecret: 'shh' }, networkInternalUrl: visionBase },
        fetchImpl: fetch, log: { warn() {}, error() {} },
    });
    const media = { async upload({ mime }) { return { url: `https://openvibe.media/o/med_${crypto.randomBytes(10).toString('hex')}`, media_ref: 'med_x', size: PNG.length, mime }; } };

    const t = await boot({ pasteLimits: { cooldownSeconds: 0 }, appOpts: { media, review } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const sam = net.addUser({ network_user_id: 9, username: 'sam', display_name: 'Sam' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const samJwt = net.sign({ id: 9, subject_id: sam.subject_id, username: 'sam', display_name: 'Sam', role: 'user' });
    const upload = async (cookie, fields = {}) => {
        const fd = new FormData();
        fd.append('screenshot', new Blob([PNG], { type: 'image/png' }), 'shot.png');
        for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
        return await t.get('/api/pastes/screenshot', { method: 'POST', body: fd, cookies: [`ov_token=${cookie}`] });
    };
    const as = (cookie, p) => t.get(p, { cookies: cookie ? [`ov_token=${cookie}`] : [] });

    try {
        let fineSlug;
        await check('fine: the paste keeps its visibility and serves to everyone', async () => {
            state.category = 'fine';
            const r = await upload(alexJwt, { title: 'A receipt', visibility: 'public' });
            assert.strictEqual(r.status, 201, r.text);
            const p = r.json().paste;
            fineSlug = p.slug;
            assert.deepStrictEqual([p.review_category, p.review_status, p.visibility, p.is_nsfw], ['fine', 'clear', 'public', false]);
            assert.strictEqual((await as(null, `/p/${fineSlug}`)).status, 200);
            assert.ok((await as(null, '/api/pastes')).json().pastes.some((x) => x.slug === fineSlug));
        });

        let sexSlug;
        await check('sex_acts: private and NSFW, gone from the public page and list, kept for its owner', async () => {
            state.category = 'sex_acts';
            const r = await upload(alexJwt, { title: 'Adult shot', visibility: 'public' });
            assert.strictEqual(r.status, 201, r.text);
            const p = r.json().paste;
            sexSlug = p.slug;
            assert.deepStrictEqual([p.review_category, p.review_status, p.visibility, p.is_nsfw], ['sex_acts', 'hidden', 'private', true]);
            assert.strictEqual((await as(null, `/p/${sexSlug}`)).status, 404);
            assert.strictEqual((await as(samJwt, `/p/${sexSlug}`)).status, 404, 'another person cannot open it');
            assert.strictEqual((await as(alexJwt, `/p/${sexSlug}`)).status, 200, 'its owner keeps it');
            assert.ok(!(await as(null, '/api/pastes')).json().pastes.some((x) => x.slug === sexSlug), 'never in the public list');
            const publish = await t.get(`/api/pastes/${sexSlug}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ visibility: 'public' }), cookies: [`ov_token=${alexJwt}`] });
            assert.deepStrictEqual([publish.status, publish.json().code], [409, 'paste.review_hidden'], 'the owner cannot re-publish it');
            const shareRow = await t.db.prepare("SELECT audience FROM shares WHERE service = 'community' AND kind = 'paste' AND resource_id = ?").get(sexSlug);
            assert.strictEqual(shareRow.audience, 'private', 'the sharing gate is closed too');
        });

        let minorSlug;
        await check('minor_sexual: private and quarantined with the operator report id', async () => {
            state.category = 'minor_sexual';
            const r = await upload(alexJwt, { title: 'Hard line', visibility: 'public' });
            assert.strictEqual(r.status, 201, r.text);
            const p = r.json().paste;
            minorSlug = p.slug;
            assert.deepStrictEqual([p.review_category, p.review_status, p.visibility, p.is_nsfw], ['minor_sexual', 'quarantined', 'private', true]);
            assert.strictEqual(p.review_report_id, 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ');
            assert.strictEqual((await as(null, `/p/${minorSlug}`)).status, 404);
            assert.strictEqual((await as(alexJwt, `/p/${minorSlug}`)).status, 200, 'the owner sees their row');
            const row = await t.db.prepare('SELECT visibility, is_nsfw, review_report_id FROM pastes WHERE slug = ?').get(minorSlug);
            assert.deepStrictEqual([row.visibility, Number(row.is_nsfw)], ['private', 1]);
            assert.strictEqual(row.review_report_id, 'vor_01JAB2C3D4E5F6G7H8J9K0MNPQ');
        });

        await check('Vision down: the paste is private and pending, never public', async () => {
            state.fail = true;
            const r = await upload(alexJwt, { title: 'Unreviewed', visibility: 'public' });
            assert.strictEqual(r.status, 201, r.text);
            const p = r.json().paste;
            assert.deepStrictEqual([p.visibility, p.review_status, p.is_nsfw], ['private', 'pending', true]);
            assert.strictEqual((await as(null, `/p/${p.slug}`)).status, 404);
        });

        await check('the review request carries the paste object and the Media URL, never the bytes', async () => {
            const last = state.requests[state.requests.length - 1];
            assert.strictEqual(last.object_type, 'community.paste');
            assert.ok(last.object_id);
            assert.match(last.image_url, /^https:\/\/openvibe\.media\/o\/med_/);
            assert.ok(!JSON.stringify(last).includes('89504e47'), 'no image bytes in the review request');
        });
    } finally {
        await t.close();
        await new Promise((r) => vision.close(r));
        done();
    }
})().catch((e) => { console.error(e); process.exit(1); });
