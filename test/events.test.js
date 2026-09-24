'use strict';
/**
 * Community's events: every write queues its community.* event in the same transaction (a failed write
 * queues nothing), payloads validate against openvibe-contracts and never carry content, and items
 * that are not public travel as internal events without a URL.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { openDb } = require('../server/db');
const events = require('../server/events');
const pastes = require('../server/pastes/store');
const forum = require('../server/forum/store');
const comments = require('../server/comments/store');

const db = openDb(':memory:');
// A relay that never publishes during the test: the rows stay in the outbox for inspection.
events.init(db, { eventsUrl: 'http://127.0.0.1:9', clientSecret: 'test-secret', intervalMs: 3_600_000, fetchImpl: async () => { throw new Error('offline'); } });
const queued = () => db.prepare("SELECT envelope FROM event_outbox ORDER BY id").all().map((r) => JSON.parse(r.envelope));
const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const ok = (env) => { const r = contracts.validate(`${env.event_type}@1`, env.payload); assert.ok(r.valid, `${env.event_type}: ${JSON.stringify(r.errors)}`); };

let n = 0;
function check(name, fn) { fn(); n++; console.log(`  ✓ ${name}`); }

check('a paste create, edit, visibility change and delete each queue one event, never the content', () => {
    const p = pastes.insertPaste(db, { slug: 'amber-fox-42', owner_subject: USR, origin: 'user', type: 'paste', title: 'secret title', content: 'secret body', language: 'text', visibility: 'public' });
    pastes.updatePaste(db, p.id, { content: 'edited body' }, USR);
    pastes.setVisibility(db, p.id, 'unlisted');
    pastes.softDelete(db, p.id);
    const evs = queued();
    assert.deepStrictEqual(evs.map((e) => e.event_type), ['community.paste.created', 'community.paste.updated', 'community.paste.updated', 'community.paste.deleted']);
    evs.forEach(ok);
    assert.ok(!JSON.stringify(evs).includes('secret'), 'no title or content in any event');
    assert.strictEqual(evs[0].visibility, 'public');
    assert.strictEqual(evs[0].payload.url, 'https://openvibe.community/p/amber-fox-42'.replace('https://openvibe.community', require('../server/config').baseUrl));
    assert.deepStrictEqual(evs[1].payload.changed, ['content']);
    assert.strictEqual(evs[2].visibility, 'internal', 'an unlisted paste is not a public event');
    assert.strictEqual(evs[2].payload.url, null);
    assert.deepStrictEqual(evs[0].actor, { type: 'user', id: USR });
});

check('a write that fails queues nothing (the event is in its transaction)', () => {
    const before = queued().length;
    assert.throws(() => pastes.insertPaste(db, { slug: 'amber-fox-42', owner_subject: USR, type: 'paste', content: 'dup', visibility: 'public' }), /UNIQUE/);
    assert.strictEqual(queued().length, before);
});

check('threads and posts: public spaces only are public events; staff spaces are members-only', () => {
    db.prepare("INSERT OR IGNORE INTO spaces (slug, name, visibility) VALUES ('general', 'General', 'public'), ('staff', 'Staff', 'staff')").run();
    const general = db.prepare("SELECT id FROM spaces WHERE slug = 'general'").get().id;
    const staff = db.prepare("SELECT id FROM spaces WHERE slug = 'staff'").get().id;
    const before = queued().length;
    const { thread } = forum.createThread(db, { space_id: general, title: 'Hello there', author_subject: USR, body_markdown: 'first post body' });
    forum.addPost(db, { thread_id: thread.id, author_subject: USR, body_markdown: 'a reply body' });
    forum.createThread(db, { space_id: staff, title: 'Staff only', author_subject: USR, body_markdown: 'hidden body' });
    const evs = queued().slice(before);
    assert.deepStrictEqual(evs.map((e) => e.event_type), ['community.thread.created', 'community.post.created', 'community.thread.created']);
    evs.forEach(ok);
    assert.strictEqual(evs[0].visibility, 'public');
    assert.ok(/\/s\/general\/t\//.test(evs[0].payload.url));
    assert.strictEqual(evs[2].visibility, 'internal');
    assert.strictEqual(evs[2].payload.visibility, 'members');
    assert.strictEqual(evs[2].payload.url, null);
    assert.ok(!JSON.stringify(evs).includes('body'), 'no post body');
});

check('a comment on a Live VOD queues community.comment.created with its ref', () => {
    const before = queued().length;
    const t = comments.resolveThread(db, { service: 'live', type: 'vod', id: '906' }).thread;
    comments.insertComment(db, { thread_id: t.id, author_subject: USR, message: 'nice stream' });
    const evs = queued().slice(before);
    assert.deepStrictEqual(evs.map((e) => e.event_type), ['community.comment.created']);
    evs.forEach(ok);
    assert.deepStrictEqual(evs[0].payload.ref, { service: 'live', type: 'vod', id: '906' });
    assert.ok(!JSON.stringify(evs).includes('nice stream'));
});

events._reset();
console.log(`community events: ${n} checks passed`);
process.exit(0);
