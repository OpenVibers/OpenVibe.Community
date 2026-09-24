'use strict';
/** Community's staff powers come from the contracts staff map: the role, or the staff_caps Network issues. */
const assert = require('assert');
const { ids } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/app');

(async () => {
    const t = await boot({ authority: 'community' });
    const net = t.network;
    const { createViewerResolver } = require('../server/identity/viewer');
    const viewers = createViewerResolver({ auth: t.app.locals.auth, config: require('../server/config'), network: null });
    const resolve = (token) => viewers.resolve({ headers: { authorization: `Bearer ${token}` }, get: () => undefined, cookies: {} });
    const tok = (claims) => net.sign({ id: Math.floor(Math.random() * 1e6), subject_id: ids.newId('user'), username: 'x', display_name: 'X', ...claims });

    await check('a global moderator is paste and discussion staff', async () => {
        const v = await resolve(tok({ role: 'global_mod' }));
        assert.deepStrictEqual([v.staff, v.discussionStaff], [true, true]);
    });
    await check('an ordinary user is neither', async () => {
        const v = await resolve(tok({ role: 'user' }));
        assert.deepStrictEqual([v.staff, v.discussionStaff], [false, false]);
    });
    await check('issued staff_caps win over the role: discussions only', async () => {
        const v = await resolve(tok({ role: 'user', staff_caps: ['staff.moderation.discussions'] }));
        assert.deepStrictEqual([v.staff, v.discussionStaff], [false, true]);
        assert.strictEqual(require('../server/identity/capabilities').discussionStaff(v), true);
    });
    done();
})();
