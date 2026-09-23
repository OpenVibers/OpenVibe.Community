'use strict';

/**
 * Shared pieces of the /api/v1/* routers (comments, spaces, pulse, relay): errors as RFC 9457
 * problems (contracts errors.problem@1, which keeps the legacy { error } field), capability
 * guards for service tokens, JSON bodies, cursors and CORS for the embeddable read/write APIs.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { checkCapability } = require('../identity/capabilities');

/** A refusal with a stable problem code (e.g. 404 'thread.not_found'). */
class ApiError extends Error {
    constructor(status, code, detail, extra) {
        super(detail || code);
        this.name = 'ApiError';
        this.status = status;
        this.code = code;
        this.extra = extra || null;
    }
}
const fail = (status, code, detail, extra) => { throw new ApiError(status, code, detail, extra); };

/** Wrap a handler: its return value is the JSON body; ApiErrors become problems. */
function run(fn, status = 200) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (out === undefined || res.headersSent) return;
            res.status(typeof status === 'function' ? status(out) : status).json(out);
        } catch (err) {
            if (res.headersSent) return;
            if (err instanceof ApiError) {
                if (err.extra && err.extra.retry_after) res.set('Retry-After', String(err.extra.retry_after));
                return contracts.http.sendProblem(res, err.status, err.code, { detail: err.message, ctx: req.ov, extra: err.extra || undefined });
            }
            console.error('[API]', err && err.stack ? err.stack : err);
            contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        }
    };
}

/** A service token must hold `cap`; browsers and anonymous callers pass (judged by identity later). */
function serviceCap(cap) {
    return (req, res, next) => {
        const v = req.viewer;
        if (!v || v.kind !== 'service') return next();
        const c = checkCapability(v.claims, cap);
        if (c.allowed) return next();
        return contracts.http.sendProblem(res, 403, c.code, { detail: c.reason, ctx: req.ov });
    };
}

/** A service token must hold at least one of `caps` (reads: a token meant for something else is no pass). */
function serviceAnyCap(caps) {
    return (req, res, next) => {
        const v = req.viewer;
        if (!v || v.kind !== 'service' || caps.some((c) => checkCapability(v.claims, c).allowed)) return next();
        return contracts.http.sendProblem(res, 403, 'capability.denied', { detail: `needs one of ${caps.join(', ')}`, ctx: req.ov });
    };
}

const jsonParser = express.json({ limit: '256kb' });
/** JSON body parser whose syntax errors are problems too. */
function jsonBody(req, res, next) {
    jsonParser(req, res, (err) => (err ? contracts.http.sendProblem(res, 400, 'request.invalid_json', { detail: 'Malformed JSON body', ctx: req.ov }) : next()));
}

// ── Cursors: opaque base64url of a small JSON tuple ──────────
function encodeCursor(values) { return Buffer.from(JSON.stringify(values)).toString('base64url'); }
function decodeCursor(cursor, arity) {
    if (cursor == null || cursor === '') return null;
    try {
        const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (Array.isArray(v) && v.length === arity) return v;
    } catch { /* fall through */ }
    return fail(400, 'request.invalid_cursor', 'That cursor is not one this API issued');
}

/**
 * CORS for the embeddable APIs: other OpenVibe sites call them from the browser with the
 * visitor's Network JWT as a Bearer token (never with cookies — no credentials mode).
 */
function cors(origins) {
    const allowed = new Set(origins);
    return (req, res, next) => {
        const origin = req.get('origin');
        if (origin && allowed.has(origin)) {
            res.set('Access-Control-Allow-Origin', origin);
            res.set('Vary', 'Origin');
            res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, traceparent, X-OpenVibe-Request-Id');
            res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
            res.set('Access-Control-Expose-Headers', 'X-OpenVibe-Request-Id, Retry-After');
            res.set('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.status(204).end();
        next();
    };
}

const intIn = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);

/** SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) ↔ ISO. */
function sqlTime(date = new Date()) { return new Date(date).toISOString().replace('T', ' ').slice(0, 19); }
function isoTime(v) {
    if (!v) return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(String(v)) ? `${String(v).replace(' ', 'T')}Z` : v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { ApiError, fail, run, serviceCap, serviceAnyCap, jsonBody, encodeCursor, decodeCursor, cors, intIn, sqlTime, isoTime };
