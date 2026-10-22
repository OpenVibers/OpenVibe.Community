'use strict';
/**
 * Public AI text never describes a person (server/pastes/no-looks.js, openvibe-sdk/no-looks): a service's AI summary
 * and tags, and an AI paste's title and body, are stored without looks or a guessed gender; a person's own title and
 * text are theirs as written; rows stored before are repaired at boot, once.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const looks = require('../server/pastes/no-looks');

(async () => {
    const t = await boot({ authority: 'community', pasteLimits: { cooldownSeconds: 0, commentCooldownSeconds: 0 } });
    const net = t.network;
    const alex = net.addUser({ network_user_id: 7, username: 'alex', display_name: 'Alex' });
    const alexJwt = net.sign({ id: 7, subject_id: alex.subject_id, username: 'alex', display_name: 'Alex', role: 'user' });
    const svc = (cap) => net.signService({ cap });
    const call = (path, { method = 'GET', token, cookie, headers = {}, json } = {}) => {
        const h = { ...headers };
        if (token) h.authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
        return t.get(path, { method, headers: h, body, cookies: cookie ? [`ov_token=${cookie}`] : [] });
    };

    await check('an AI paste from a service: title, body, summary and tags carry no looks; the footer stays', async () => {
        const r = await call('/api/pastes', {
            method: 'POST', token: svc(['community.paste.create']), headers: { 'x-ov-origin': 'ai' },
            json: {
                title: 'A Shirtless Man Cooks', slug: 'cooks-1',
                content: 'A shirtless man in a red hoodie cooks pasta.\n\n🔴 Caught live on @chef\'s stream — https://openvibe.live/@chef',
                ai_summary: 'A man wearing a hat cooks pasta.', ai_tags: ['man', 'pasta', 'red-hoodie'],
            },
        });
        assert.strictEqual(r.status, 201, r.text);
        const p = r.json().paste;
        assert.strictEqual(p.title, 'The streamer Cooks');
        assert.strictEqual(p.content, 'The streamer cooks pasta.\n\n🔴 Caught live on @chef\'s stream — https://openvibe.live/@chef');
        assert.strictEqual(p.ai_summary, 'A person cooks pasta.');
        assert.deepStrictEqual(JSON.parse(p.ai_tags), ['pasta']);
    });

    await check('a person\'s paste: their title and text as written; the AI summary of it follows the rule', async () => {
        const r = await call('/api/pastes', { method: 'POST', cookie: alexJwt, json: { title: 'A man and his dog', content: 'A man in a red shirt walks his dog.' } });
        assert.strictEqual(r.status, 201, r.text);
        const slug = r.json().slug;
        assert.strictEqual(r.json().paste.title, 'A man and his dog');
        assert.strictEqual(r.json().paste.content, 'A man in a red shirt walks his dog.');
        const w = await call(`/api/pastes/${slug}/ai`, { method: 'POST', token: svc(['community.paste.moderate']), json: { ai_summary: 'Close-up selfie of a man, taken outdoors.', ai_tags: '["selfie","outdoors","beard"]' } });
        assert.strictEqual(w.status, 200, w.text);
        assert.strictEqual(w.json().paste.ai_summary, 'Close-up selfie of a person, taken outdoors.');
        assert.deepStrictEqual(JSON.parse(w.json().paste.ai_tags), ['outdoors']);
        const row = await t.db.prepare('SELECT title, content FROM pastes WHERE slug = ?').get(slug);
        assert.deepStrictEqual([row.title, row.content], ['A man and his dog', 'A man in a red shirt walks his dog.']);
    });

    await check('rows stored before the rule are repaired once; a person\'s text is untouched; a second pass changes nothing', async () => {
        const ins = (origin, title, content, summary, tags) => t.db.prepare(`INSERT INTO pastes (slug, origin, type, title, content, language, visibility, ai_summary, ai_tags)
            VALUES (?, ?, 'paste', ?, ?, 'text', 'public', ?, ?)`).run(`old-${Math.random().toString(36).slice(2, 10)}`, origin, title, content, summary, tags);
        await ins('ai', 'A Close-Up Selfie Moment Where A Man Looks Straight', 'Close-up selfie of a man, taken outdoors with trees in the background.\n\n▶ Watch this moment on @x\'s stream: https://openvibe.video/v/1', 'Close-up selfie of a man, taken outdoors with trees in the background.', '["man","trees"]');
        await ins('user', 'Two men at a desk', 'Two men at a desk.', 'A man lounging on a sofa, holding a remote.', 'sofa, man');
        await ins('user', 'Notes', 'my notes', 'A list of notes about a game.', null);
        const n = await looks.repairStored(t.db, { log: null });
        assert.strictEqual(n, 2);
        const ai = await t.db.prepare("SELECT title, content, ai_summary, ai_tags FROM pastes WHERE title LIKE 'A Close-Up%'").get();
        assert.strictEqual(ai.title, 'A Close-Up Selfie Moment Where A person Looks Straight');
        assert.strictEqual(ai.content, 'Close-up selfie of a person, taken outdoors with trees in the background.\n\n▶ Watch this moment on @x\'s stream: https://openvibe.video/v/1');
        assert.strictEqual(ai.ai_summary, 'Close-up selfie of a person, taken outdoors with trees in the background.');
        assert.strictEqual(ai.ai_tags, '["trees"]');
        const user = await t.db.prepare("SELECT title, content, ai_summary, ai_tags FROM pastes WHERE title = 'Two men at a desk'").get();
        assert.deepStrictEqual([user.title, user.content], ['Two men at a desk', 'Two men at a desk.'], 'a person\'s own words stay');
        assert.strictEqual(user.ai_summary, 'A person lounging on a sofa, holding a remote.');
        assert.strictEqual(user.ai_tags, 'sofa');
        assert.strictEqual(await looks.repairStored(t.db, { log: null }), 0, 'nothing left to repair');
    });

    await check('helpers: non-strings pass through; a body or title that is all looks leaves nothing of it', async () => {
        assert.strictEqual(looks.summary(null), null);
        assert.strictEqual(looks.tags(null), null);
        assert.deepStrictEqual(looks.tags(['hat', 'game']), ['game']);
        assert.strictEqual(looks.body('A person adjusts their hair.\n\n🔴 Caught live on @x\'s stream'), '🔴 Caught live on @x\'s stream', 'a description that was all looks leaves the footer');
        assert.strictEqual(looks.body('A person adjusts their hair.'), '');
        assert.strictEqual(looks.body("A desk.\n\n▶ Watch this moment on @null's stream: https://openvibe.video/v/9"), 'A desk.\n\n▶ Watch this moment on the stream: https://openvibe.video/v/9');
        assert.strictEqual(looks.body("A man at a desk.\r\n\r\n▶ Watch this moment on @null's stream: https://openvibe.video/v/9"), 'A person at a desk.\r\n\r\n▶ Watch this moment on the stream: https://openvibe.video/v/9', 'CRLF, as Live writes it');
        assert.strictEqual(looks.cleanRow({ origin: 'ai', title: 'A person adjusts their hair' }).title, 'Untitled');
    });

    done();
})().catch((err) => { console.error(err); process.exit(1); });
