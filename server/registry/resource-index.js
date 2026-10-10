'use strict';
/**
 * Community's authority index for OpenVibe.Services (ADR-048, plan T13; capability community.resource.read). A
 * person's pastes and the spaces they created, so "Your resources" on openvibe.services shows them beside their
 * robots, rooms, streams, watches and Actor tasks. Both kinds are person-owned: no project, no OVRN.
 *
 *   GET /api/v1/resources?kind=&owner=&project=&cursor=&limit=   common.resource-list-result@1
 *       community.paste  id the slug, named by its title, state its visibility, owner its owner (deleted ones left out)
 *       community.space  id the slug, named by its name, state its visibility, owner the person who created it
 *       Pastes first, then spaces, each by slug; the cursor is opaque ([kind, slug]). owner (a usr_/agt_ id) keeps
 *       what that subject owns; project always answers an empty page (nothing here belongs to a project).
 *   GET /api/v1/resources/:ovrn   404 for every name (nothing here has one)
 *
 * First-party only: a service token holding community.resource.read. nginx answers 404 for the path on the public
 * vhost; Services reads it on loopback.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { hasCap } = require('../identity/viewer');

const SERVICE = 'community';
const KINDS = ['community.paste', 'community.space'];
const PROJECT_ID_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const OWNER_SUBJECT_RE = /^(usr|agt)_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** Community stores UTC as 'YYYY-MM-DD HH:MM:SS'; a summary carries ISO 8601. */
function iso(text) {
    if (!text) return null;
    const d = new Date(String(text).includes('T') ? String(text) : `${String(text).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function ownerOf(subject) {
    const s = String(subject || '');
    if (!OWNER_SUBJECT_RE.test(s)) return null;
    return { type: s.startsWith('agt_') ? 'agent' : 'user', id: s };
}

/** One row → common.resource-summary@1. Nothing else of a paste (its content, its views) leaves this index. */
function summaryOf(kind, row) {
    const out = {
        id: row.slug, kind, service: SERVICE,
        name: kind === 'community.paste' ? row.title : row.name,
        state: row.visibility,
        created_at: iso(row.created_at),
    };
    const updated = iso(row.updated_at);
    if (updated) out.updated_at = updated;
    const owner = ownerOf(row.owner);
    if (owner) out.owner = owner;
    return out;
}

const encodeCursor = (s) => Buffer.from(JSON.stringify([s.kind, s.id])).toString('base64url');
function decodeCursor(raw) {
    let v;
    try { v = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8')); } catch { return null; }
    return Array.isArray(v) && v.length === 2 && KINDS.includes(v[0]) && typeof v[1] === 'string' && v[1] !== '' ? { kind: v[0], id: v[1] } : null;
}

function filtersOf(query) {
    const project = query.project === undefined || query.project === '' ? null : query.project;
    if (project !== null && (typeof project !== 'string' || !PROJECT_ID_RE.test(project))) return { error: 'project must be a prj_ id' };
    const owner = query.owner === undefined || query.owner === '' ? null : query.owner;
    if (owner !== null && (typeof owner !== 'string' || !OWNER_SUBJECT_RE.test(owner))) return { error: 'owner must be a usr_ or agt_ id' };
    const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : null;
    let limit = DEFAULT_LIMIT;
    if (typeof query.limit === 'string' && query.limit !== '') {
        if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1 || Number(query.limit) > MAX_LIMIT) return { error: `limit must be an integer 1-${MAX_LIMIT}` };
        limit = Number(query.limit);
    }
    let cursor = null;
    if (typeof query.cursor === 'string' && query.cursor !== '') {
        cursor = decodeCursor(query.cursor);
        if (!cursor) return { error: 'cursor is not one this index issued' };
    }
    return { project, owner, kind, limit, cursor };
}

const QUERIES = {
    'community.paste': (owner) => `SELECT slug, title, visibility, owner_subject AS owner, created_at, updated_at FROM pastes
        WHERE deleted_at IS NULL AND slug > ?${owner ? ' AND owner_subject = ?' : ''} ORDER BY slug LIMIT ?`,
    'community.space': (owner) => `SELECT slug, name, visibility, created_by AS owner, created_at, NULL AS updated_at FROM spaces
        WHERE slug > ?${owner ? ' AND created_by = ?' : ''} ORDER BY slug LIMIT ?`,
};

/** One page across both kinds (pastes, then spaces), limit + 1 rows to know whether there is a next page. */
async function page(db, f) {
    const kinds = f.kind ? KINDS.filter((k) => k === f.kind) : KINDS;
    const out = [];
    for (const kind of kinds) {
        if (f.cursor && KINDS.indexOf(kind) < KINDS.indexOf(f.cursor.kind)) continue;
        const need = f.limit + 1 - out.length;
        if (need <= 0) break;
        const from = f.cursor && f.cursor.kind === kind ? f.cursor.id : '';
        const rows = await db.prepare(QUERIES[kind](f.owner)).all(from, ...(f.owner ? [f.owner] : []), need);
        for (const row of rows) out.push(summaryOf(kind, row));
    }
    return { resources: out.slice(0, f.limit), next_cursor: out.length > f.limit ? encodeCursor(out[f.limit - 1]) : null };
}

function router({ db, viewers }) {
    const r = express.Router();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const handle = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

    r.use(viewers.middleware());
    r.use((req, res, next) => {
        const v = req.viewer || { kind: 'anonymous' };
        if (v.kind === 'service' && hasCap(v, 'community.resource.read')) return next();
        if (v.kind === 'anonymous') return problem(req, res, 401, 'token.missing', 'call with a service token holding community.resource.read');
        return problem(req, res, 403, 'capability.denied', 'community.resource.read is first-party and requires a service token that holds it');
    });

    r.get('/', handle(async (req, res) => {
        const f = filtersOf(req.query);
        if (f.error) return problem(req, res, 400, 'resources.bad_query', f.error);
        res.set('Cache-Control', 'private, max-age=60');
        if (f.project) return res.json({ resources: [], next_cursor: null });
        return res.json(await page(db, f));
    }));
    r.get('/:ovrn', (req, res) => problem(req, res, 404, 'resources.unknown_resource', `no resource named ${String(req.params.ovrn).slice(0, 200)}`));
    return r;
}

module.exports = { router, summaryOf, filtersOf, encodeCursor, decodeCursor, iso, SERVICE, KINDS, DEFAULT_LIMIT, MAX_LIMIT };
