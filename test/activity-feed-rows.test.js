'use strict';
/**
 * The feed rows Community exports (GET /api/v1/activity), which OpenVibe.Network's collector reads:
 * a paste and a picture name their author, and a picture whose title is a camera's file name takes
 * the caption's first words instead (the owner, 11-13: "it should say who posted it").
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/app');
const { pictureTitle } = require('../server/activity/service');

const SUBJECT = 'usr_01JQ8Z6K6M0V8Y2Q3R4S5T6V7W';

(async () => {
    const t = await boot({ appOpts: { startRelay: false, startSharingWorker: false } });
    const at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    await check('a paste carries its author, so the feed can name the person', async () => {
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, created_at)
            VALUES (?, ?, 'user', 'paste', ?, ?, 'public', ?)`).run('authored-paste', SUBJECT, 'A public paste', 'hello', at);
        const items = (await t.get('/api/v1/activity?limit=50')).json().items;
        const paste = items.find((i) => i.id === 'authored-paste');
        assert.ok(paste, 'the paste is in the activity');
        assert.strictEqual(paste.actor, SUBJECT, 'with the subject of the person who posted it');
    });

    await check('a picture carries its author too', async () => {
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, screenshot_url, created_at)
            VALUES (?, ?, 'user', 'screenshot', ?, ?, 'public', ?, ?)`).run('authored-picture', SUBJECT, '1000012166',
            'Current read, it is so thin but the topic is heavy', 'https://openvibe.media/o/med_01M78B3X3FSAA9V8DRERBV4DTT', at);
        const items = (await t.get('/api/v1/activity?limit=50')).json().items;
        const picture = items.find((i) => i.id === 'authored-picture');
        assert.ok(picture, 'the picture is in the activity');
        assert.strictEqual(picture.actor, SUBJECT, 'with the subject of the person who posted it');
        assert.strictEqual(picture.kind, 'pic');
    });

    await check('a picture titled with a camera file name takes the caption\'s first words', async () => {
        const items = (await t.get('/api/v1/activity?limit=50')).json().items;
        const picture = items.find((i) => i.id === 'authored-picture');
        assert.strictEqual(picture.title, 'Current read, it is so thin but the topic is heavy',
            'not the camera file name');
        assert.strictEqual(picture.text, 'Current read, it is so thin but the topic is heavy', 'the caption is still the text');
    });

    await check('a picture with no caption is "A picture"', async () => {
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, screenshot_url, created_at)
            VALUES (?, ?, 'user', 'screenshot', ?, ?, 'public', ?, ?)`).run('nameless-picture', SUBJECT, 'IMG_1234', '',
            'https://openvibe.media/o/med_01M78B3X3FSAA9V8DRERBV4DTT', at);
        const items = (await t.get('/api/v1/activity?limit=50')).json().items;
        assert.strictEqual(items.find((i) => i.id === 'nameless-picture').title, 'A picture');
    });

    await check('a picture with a title the person wrote keeps it', async () => {
        await t.db.prepare(`INSERT INTO pastes (slug, owner_subject, origin, type, title, content, visibility, screenshot_url, created_at)
            VALUES (?, ?, 'user', 'screenshot', ?, ?, 'public', ?, ?)`).run('named-picture', SUBJECT, 'Lentil Soup', 'a bowl',
            'https://openvibe.media/o/med_01M78B3X3FSAA9V8DRERBV4DTT', at);
        const items = (await t.get('/api/v1/activity?limit=50')).json().items;
        assert.strictEqual(items.find((i) => i.id === 'named-picture').title, 'Lentil Soup');
    });

    await check('the rule itself: a camera file name, and nothing else', () => {
        assert.strictEqual(pictureTitle('1000012166', 'A caption'), 'A caption');
        assert.strictEqual(pictureTitle('IMG_1234', 'A caption'), 'A caption');
        assert.strictEqual(pictureTitle('1000012166.jpg', ''), 'A picture');
        assert.strictEqual(pictureTitle('Lentil Soup', 'a caption'), null, 'a title the person wrote is left alone');
        assert.strictEqual(pictureTitle('Recipe 42', 'a caption'), null);
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
