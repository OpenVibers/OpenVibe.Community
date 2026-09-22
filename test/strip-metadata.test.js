'use strict';
/** Uploaded images lose EXIF/XMP/text metadata without being re-encoded (server/media/strip-metadata.js). */
const assert = require('assert');
const zlib = require('zlib');
const { stripImageMetadata } = require('../server/media/strip-metadata');
const { check, done } = require('./helpers/app');

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function riffChunk(type, data) {
    const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
    return Buffer.concat([head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

(async () => {
    await check('PNG: tEXt / eXIf / iTXt chunks removed, image chunks kept byte-for-byte', async () => {
        const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
        const idat = pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0])));
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr,
            pngChunk('tEXt', Buffer.from('Author\0Secret Person', 'latin1')), pngChunk('eXIf', Buffer.from('MM\0*GPS', 'latin1')),
            idat, pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<gps/>', 'latin1')), pngChunk('IEND', Buffer.alloc(0))]);
        const out = stripImageMetadata(png, 'image/png');
        assert.ok(!out.includes(Buffer.from('Secret')) && !out.includes(Buffer.from('GPS')) && !out.includes(Buffer.from('<gps/>')));
        assert.ok(out.includes(ihdr) && out.includes(idat));
        assert.ok(out.subarray(out.length - 12).equals(pngChunk('IEND', Buffer.alloc(0))));
    });

    await check('WebP: EXIF and XMP chunks removed, VP8X flags cleared, RIFF size fixed', async () => {
        const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c | 0x10; // EXIF + XMP + alpha flags
        const body = Buffer.concat([riffChunk('VP8X', vp8x), riffChunk('VP8L', Buffer.from('imagebytes')), riffChunk('EXIF', Buffer.from('GPS-DATA')), riffChunk('XMP ', Buffer.from('<x/>'))]);
        const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
        const out = stripImageMetadata(Buffer.concat([head, body]), 'image/webp');
        assert.ok(!out.includes(Buffer.from('GPS-DATA')) && !out.includes(Buffer.from('<x/>')));
        assert.ok(out.includes(Buffer.from('imagebytes')));
        assert.strictEqual(out.readUInt32LE(4), out.length - 8);
        assert.strictEqual(out[20] & 0x0c, 0, 'EXIF/XMP flags cleared');
        assert.strictEqual(out[20] & 0x10, 0x10, 'other flags kept');
    });

    await check('GIFs and anything unparseable pass through unchanged', async () => {
        const gif = Buffer.from('GIF89a....');
        assert.strictEqual(stripImageMetadata(gif, 'image/gif'), gif);
        const junk = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
        assert.strictEqual(stripImageMetadata(junk, 'image/jpeg'), junk);
    });

    done();
})();
