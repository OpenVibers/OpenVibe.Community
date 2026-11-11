'use strict';
/**
 * Comments on an OpenVibe.Pics picture, and a picture embedded in a paste.
 *
 * A picture's thread is opened by its unlisted page, so Community asks Pics whether the picture is active
 * right now. Anything hidden or gone fails closed (404). A paste may embed a picture from the fixed
 * Pics origin, raster formats only.
 */
const assert = require('assert');
const { createCommentService } = require('../server/comments/service');
const { renderMarkdown } = require('../server/render/markdown');

const PICTURE = 'pic_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const picture = (over = {}) => ({ id: PICTURE, slug: 'Abcdef23', state: 'active', ...over });

(async () => {
    const answers = [];
    let requests = 0;
    const service = createCommentService({ db: { tx: async () => { throw new Error('reached store'); } },
        fetchImpl: async () => { requests++; const body = answers.shift() || { ok: false }; return { ok: body.ok !== false, json: async () => body.body || body }; } });

    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: 'not-a-picture' } }),
        (e) => e.code === 'ref.not_found', 'an id that is not a picture is refused');
    assert.equal(requests, 0, 'and nothing was asked of Pics');

    answers.push({ body: picture() });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.message === 'reached store', 'an active unlisted picture may open a thread');

    answers.push({ body: picture({ state: 'hidden' }) });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'a hidden picture has no thread');

    answers.push({ body: picture({ slug: undefined }) });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'a picture without a public slug is not exposed');

    answers.push({ ok: false });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'and Pics saying nothing fails closed');

    // A paste may embed a picture: the fixed origin, raster formats only.
    const embed = renderMarkdown('![forest](https://openvibe.pics/i/Abcdef23.png)');
    assert.ok(embed.includes('<img'), 'a Pics picture embeds as an image');
    assert.ok(embed.includes('https://openvibe.pics/i/Abcdef23.png'), 'and keeps its address');
    assert.ok(!renderMarkdown('![x](https://openvibe.pics/i/Abcdef23.svg)').includes('<img'), 'no SVG');
    assert.ok(!renderMarkdown('![x](https://openvibe.example/i/Abcdef23.png)').includes('<img'), 'no other origin');
    assert.ok(!renderMarkdown('![x](https://openvibe.pics/i/Abcdef23.png?x=1)').includes('<img'), 'no query strings');
    assert.ok(!renderMarkdown('![x](https://openvibe.pics/a/Abcdef23.png)').includes('<img'), 'no album paths');

    process.stdout.write('Active unlisted Pics comments and fixed-origin raster embeds pass\n');
})().catch((e) => { process.stderr.write(e.stack + '\n'); process.exit(1); });
