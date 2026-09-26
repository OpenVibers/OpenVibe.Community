'use strict';
// ═══════════════════════════════════════════════════════════════
// Graceful stop for OpenVibe.Community (roadmap WS-P lifecycle; openvibe-contracts
// manifests/services/community.json → lifecycle.shutdown). systemd sends SIGTERM on a restart or a deploy;
// SIGINT does the same by hand. On the first signal:
//
//   1. `stop` steps run: timers and scans stop taking new work (nothing new starts);
//   2. the HTTP server stops taking connections, idle keep-alive connections are closed, requests in
//      flight are answered with `Connection: close`, and open event streams (text/event-stream) are
//      closed — EventSource reconnects on its own;
//   3. the requests in flight finish, for at most `drainMs`; whatever is still open then is cut;
//   4. `close` steps run: the relays settle, the database closes;
//   5. the process exits 0.
//
// A hard `deadlineMs` bounds the whole stop (the manifest's deadlineSeconds): past it the process
// exits 1. A second signal while stopping changes nothing.
// ═══════════════════════════════════════════════════════════════

const DRAIN_MS = 4000;
const DEADLINE_MS = 5000;

/**
 * @param {object} o
 * @param {string} o.name                    log prefix, e.g. 'Community'
 * @param {import('http').Server} o.server
 * @param {Array<Function>} [o.stop]         run first, in order (sync or async; a failure is logged)
 * @param {Array<Function>} [o.close]        run after the HTTP drain, in order
 * @param {number} [o.drainMs]               how long requests in flight may take (default 4000)
 * @param {number} [o.deadlineMs]            the whole stop, else exit 1 (default 5000)
 * @param {boolean} [o.signals]              false: do not install SIGTERM/SIGINT handlers (tests)
 * @param {(code:number) => void} [o.exit]   default process.exit
 * @returns {{ stop(signal?: string): Promise<number>, stopping(): boolean }}
 */
function gracefulStop(o) {
    const { name, server } = o;
    const drainMs = o.drainMs == null ? DRAIN_MS : o.drainMs;
    const deadlineMs = o.deadlineMs == null ? DEADLINE_MS : o.deadlineMs;
    const log = o.log || console;
    const exit = o.exit || ((code) => process.exit(code));
    let started = null;

    // Every response in flight, so the stop can mark them Connection: close and close event streams.
    const inflight = new Set();
    server.prependListener('request', (req, res) => {
        if (started && !res.headersSent) res.setHeader('Connection', 'close');
        inflight.add(res);
        res.on('close', () => inflight.delete(res));
    });

    async function step(fn, phase) {
        try { await fn(); } catch (err) { log.warn(`[${name}] stop: ${phase} step failed: ${err && err.message}`); }
    }

    function isEventStream(res) {
        const ct = String(res.getHeader('content-type') || '');
        return /text\/event-stream/i.test(ct) || (typeof res._header === 'string' && /content-type:\s*text\/event-stream/i.test(res._header));
    }

    function drain() {
        return new Promise((resolve) => {
            let done = false;
            const finish = (cut) => {
                if (done) return;
                done = true;
                clearInterval(sweep);
                clearTimeout(timer);
                resolve(cut);
            };
            server.close(() => finish(0));
            for (const res of inflight) {
                if (isEventStream(res)) res.destroy();
                else if (!res.headersSent) res.setHeader('Connection', 'close');
            }
            // A connection whose response just finished goes idle: close it now rather than after keepAliveTimeout.
            const idle = () => { if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections(); };
            idle();
            const sweep = setInterval(idle, 50);
            const timer = setTimeout(() => {
                const cut = inflight.size;
                if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                finish(cut || 1);
            }, drainMs);
        });
    }

    function stop(signal = 'stop') {
        if (started) return started;
        started = (async () => {
            const t0 = Date.now();
            log.log(`[${name}] ${signal}: stopping (requests in flight get ${drainMs} ms)`);
            const hard = setTimeout(() => { log.error(`[${name}] stop took longer than ${deadlineMs} ms: exiting 1`); exit(1); }, deadlineMs);
            if (hard.unref) hard.unref();
            for (const fn of o.stop || []) await step(fn, 'stop');
            const cut = await drain();
            if (cut) log.warn(`[${name}] ${cut} request(s) still open after ${drainMs} ms were cut`);
            for (const fn of o.close || []) await step(fn, 'close');
            clearTimeout(hard);
            log.log(`[${name}] stopped in ${Date.now() - t0} ms`);
            exit(0);
            return 0;
        })();
        return started;
    }

    if (o.signals !== false) {
        process.on('SIGTERM', () => { stop('SIGTERM'); });
        process.on('SIGINT', () => { stop('SIGINT'); });
    }
    return { stop, stopping: () => !!started };
}

/** Await `promise`, but no longer than `ms` (a best-effort step inside the deadline). */
function within(ms, promise) {
    return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); })]);
}

module.exports = { gracefulStop, within, DRAIN_MS, DEADLINE_MS };
