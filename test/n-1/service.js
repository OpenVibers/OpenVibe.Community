'use strict';
/**
 * Community's side of the N-1 harness (test/n-1/harness.js): its clients, how a release boots and is
 * seeded, where its SQL lives. Used by scripts/n-1-record.js (on N-1, in a temporary worktree) and by
 * test/n-1.test.js (on this checkout), so both boot and seed the same way.
 *
 * Community's clients are its pages: public/js/community.js, the forms and scripts the templates in
 * server/render write (an open tab posts the form it was served), the links, scripts and forms of the
 * pages N-1 served (crawled), and the openvibe-sdk community client (pastes) as that release installed it.
 *
 * A release boots in a child process (test/n-1/boot-child.js) with its own Live, Network and Media
 * mocks, the pastes authority on, and its database at COMMUNITY_DB_PATH; sign-in is the ov_token
 * cookie the Network mock signs.
 */
const path = require('path');
const { spawn } = require('child_process');
const { readTree } = require('./harness');

const PRELOAD = path.join(__dirname, 'preload.js');
const CHILD = path.join(__dirname, 'boot-child.js');

function baseEnv(extra) {
    return { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', NODE_ENV: 'test', ...extra };
}

module.exports = {
    service: 'community',

    clientFiles(dir) {
        return readTree(dir, ['public/js', 'server/render', 'node_modules/openvibe-sdk/src/community.js'], ['.js']);
    },
    callers: [
        { name: 'api' },
        { name: 'fetch' },
        { name: 'call', object: true },
    ],
    forms: true,
    keep: () => true,
    /** Pages an open tab may hold (anonymous): every link, script and form in them is replayed too. */
    crawl: ['/', '/pastes', '/p/{@paste}', '/s/general', '/s/general/t/n-1-thread', '/c/{@comment_access}', '/search', '/pulse', '/new', '/my'],
    origins: ['https://openvibe.community'],
    /** Values for template expressions, first match wins; '@name' is a seeded row (boot-child.js ids). */
    samples: [
        [/space/i, 'general'],
        [/thread\.slug/i, 'n-1-thread'],
        [/access_?id/i, '@comment_access'],
        [/comment_?id/i, '1'],
        [/slug|data-copy-content|data-delete/i, '@paste'],
        [/user_?name/i, 'n1star'],
        [/id\)*$/i, '1'],
    ],

    sqlDirs: ['server'],
    ledgerTables: [],

    /** Community migrates when it opens its database (server/db.js openDb); nothing to do first. */
    seed() {},

    /** Boots the release in `dir` on dbPath → { url, ids, headers(auth), close() }. */
    async boot({ dir, dbPath, sqlOut = '' }) {
        const child = spawn(process.execPath, ['-r', PRELOAD, CHILD], {
            cwd: dir,
            env: baseEnv({ N1_DB: dbPath, N1_SQL_OUT: sqlOut }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let log = '';
        let info = null;
        const ready = new Promise((resolve, reject) => {
            child.stdout.on('data', (c) => {
                log = (log + c).slice(-20000);
                const line = String(c).split('\n').find((l) => l.startsWith('{"n1":'));
                if (line && !info) { info = JSON.parse(line).n1; resolve(); }
            });
            child.on('exit', () => reject(new Error(`the release in ${dir} exited while booting:\n${log.slice(-3000)}`)));
        });
        child.stderr.on('data', (c) => { log = (log + c).slice(-20000); });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
        await ready;
        clearTimeout(timer);
        return {
            url: info.url,
            ids: info.ids,
            log: () => log,
            headers: (auth) => (auth === 'user' ? { cookie: `ov_token=${info.token}` } : {}),
            async close() {
                if (child.exitCode == null) child.kill('SIGTERM');
                const t = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 8000);
                await exited;
                clearTimeout(t);
            },
        };
    },
};
