'use strict';
/**
 * Comments on an OpenVibe.Pics picture, and a picture embedded in a paste.
 *
 * A picture's thread is opened by the picture's own page, so Community asks Pics whether the picture is public
 * right now: listed, active, and with public counts. Anything else fails closed (404, never a hint that the
 * picture exists). A paste may embed a picture from the fixed Pics origin, raster formats only.
 */
const assert = require('assert');
const { createCommentService } = require('../server/comments/service');
const { renderMarkdown } = require('../server/render/markdown');

const PICTURE = 'pic_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const listed = (over = {}) => ({ id: PICTURE, listed: true, state: 'active', views: 3, ...over });

(async () => {
    const answers = [];
    let requests = 0;
    const service = createCommentService({ db: {}, fetchImpl: async () => { requests++; const body = answers.shift() || { ok: false }; return { ok: body.ok !== false, json: async () => body.body || body }; } });

    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: 'not-a-picture' } }),
        (e) => e.code === 'ref.not_found', 'an id that is not a picture is refused');
    assert.equal(requests, 0, 'and nothing was asked of Pics');

    answers.push({ body: listed({ listed: false }) });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'an unlisted picture has no thread');

    answers.push({ body: listed({ state: 'hidden' }) });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'a hidden picture has no thread');

    answers.push({ body: listed({ views: undefined }) });
    await assert.rejects(service.resolve({ kind: 'anonymous' }, { ref: { service: 'pics', type: 'picture', id: PICTURE } }),
        (e) => e.code === 'ref.not_found', 'a picture without public counts is not a public picture');

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

    process.stdout.write('Pics comments fail closed; fixed-origin raster embeds pass\n');
})().catch((e) => { process.stderr.write(e.stack + '\n'); process.exit(1); });
