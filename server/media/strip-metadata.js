'use strict';

/**
 * Drop embedded metadata (EXIF incl. GPS, XMP, text chunks) from an uploaded image without
 * re-encoding it. Media used to do this by re-encoding with sharp; Community has no image
 * library, and the pixels don't need touching — only the side-channel segments do.
 *
 *   JPEG  — APP1 (EXIF/XMP) and APP13 (IPTC/Photoshop) segments and COM comments are removed;
 *           APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe) stay.
 *   PNG   — eXIf, tEXt, zTXt, iTXt and tIME chunks are removed.
 *   WebP  — EXIF and XMP chunks are removed and the VP8X flags updated.
 *   GIF   — left alone (animations survive; GIF carries no EXIF).
 * Anything that doesn't parse cleanly is returned unchanged.
 */

function stripJpeg(buf) {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
    const parts = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
        if (buf[i] !== 0xff) return buf;
        const marker = buf[i + 1];
        if (marker === 0xda) { parts.push(buf.subarray(i)); return Buffer.concat(parts); } // start of scan: rest is image data
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(buf.subarray(i, i + 2)); i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2 || i + 2 + len > buf.length) return buf;
        const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
        if (!drop) parts.push(buf.subarray(i, i + 2 + len));
        i += 2 + len;
    }
    return buf;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);
function stripPng(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return buf;
    const parts = [PNG_SIG];
    let i = 8;
    while (i + 12 <= buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('latin1', i + 4, i + 8);
        const end = i + 12 + len;
        if (end > buf.length) return buf;
        if (!PNG_DROP.has(type)) parts.push(buf.subarray(i, end));
        i = end;
        if (type === 'IEND') return Buffer.concat(parts);
    }
    return buf;
}

function stripWebp(buf) {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return buf;
    const chunks = [];
    let i = 12;
    while (i + 8 <= buf.length) {
        const type = buf.toString('latin1', i, i + 4);
        const len = buf.readUInt32LE(i + 4);
        const end = i + 8 + len + (len & 1);
        if (i + 8 + len > buf.length) return buf;
        if (type !== 'EXIF' && type !== 'XMP ') chunks.push(Buffer.from(buf.subarray(i, Math.min(end, buf.length))));
        i = end;
    }
    for (const c of chunks) {
        // VP8X flags byte: bit 3 = EXIF present, bit 2 = XMP present.
        if (c.toString('latin1', 0, 4) === 'VP8X' && c.length > 8) c[8] &= ~0x0c;
    }
    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    return Buffer.concat([head, body]);
}

function stripImageMetadata(buf, mime) {
    try {
        if (mime === 'image/jpeg') return stripJpeg(buf);
        if (mime === 'image/png') return stripPng(buf);
        if (mime === 'image/webp') return stripWebp(buf);
    } catch { /* fall through: unchanged */ }
    return buf;
}

module.exports = { stripImageMetadata, stripJpeg, stripPng, stripWebp };
