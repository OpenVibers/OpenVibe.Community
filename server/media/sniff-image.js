'use strict';

/**
 * The image type from a buffer's first bytes — never the file name or the client-declared
 * Content-Type. Nothing that decides how to strip metadata or what Media stores may trust a
 * caller's `mimetype`: a JPEG declaring image/png would otherwise skip PNG stripping entirely.
 * Returns 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', or null for anything else.
 */
function sniffImage(b) {
    if (!Buffer.isBuffer(b) || b.length < 12) return null;
    if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

module.exports = { sniffImage };
