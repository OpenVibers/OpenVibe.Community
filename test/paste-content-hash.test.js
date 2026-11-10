'use strict';
const assert = require('assert');
const crypto = require('crypto');
const { fillBatch } = require('../server/pastes/content-hash');

const rows = [
    { id: 1, type: 'paste', content: 'hello', content_hash: null },
    { id: 2, type: 'screenshot', media_ref: 'med_01JAB2C3D4E5F6G7H8J9K0MNPA', content_hash: null },
    { id: 3, type: 'paste', content: 'later', content_hash: null },
];
const db = {
    prepare(sql) {
        return {
            all: async (limit) => rows.filter((r) => !r.content_hash).slice(0, limit),
            run: async (hash, sourceHash, id) => {
                const row = rows.find((r) => r.id === id);
                if (!row || row.content_hash) return { changes: 0 };
                row.content_hash = hash; row.source_hash = row.source_hash || sourceHash; return { changes: 1 };
            },
        };
    },
};

(async () => {
    const imageHash = 'a'.repeat(64);
    const result = await fillBatch({ db, limit: 2, media: { object: async () => ({ content_hash: imageHash }) } });
    assert.deepStrictEqual(result, { scanned: 2, filled: 2 });
    assert.strictEqual(rows[0].content_hash, crypto.createHash('sha256').update('hello').digest('hex'));
    assert.deepStrictEqual([rows[1].content_hash, rows[1].source_hash], [imageHash, imageHash]);
    const retry = await fillBatch({ db, limit: 2 });
    assert.deepStrictEqual(retry, { scanned: 1, filled: 1 });
    console.log('paste content hash: batches are bounded and retryable');
})().catch((error) => { console.error(error); process.exit(1); });
