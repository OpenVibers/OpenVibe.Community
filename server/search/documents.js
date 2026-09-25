'use strict';
/**
 * Community's threads and pastes in OpenVibe.Search (roadmap WS-O task 10; Contracts 0.44.0
 * community.index_document.upserted|deleted): one document per public forum thread (a public, open
 * space and an open thread) and per public paste, published through Community's outbox (../events.js)
 * in a transaction with the push record, and a tombstone once it is deleted, made private, unlisted or
 * members-only, or burns after reading. Search takes them through its '*.index_document.*' subscription.
 *
 *   scan()     every minute: every thread (a space's visibility has no timestamp, and there are few),
 *              and the pastes changed or deleted since the previous scan
 *   refresh()  hourly: every paste, and a tombstone for any sent paste that no longer exists
 *
 * A document is sent only when what Search should hold changed (search_doc_pushes keeps a hash and the
 * revision, which grows by one with every document or tombstone). NSFW pastes and crossposts are
 * indexed noindex, as their pages are or should be. Off while the outbox is off (EVENTS_URL unset).
 */
const crypto = require('crypto');
const config = require('../config');
const events = require('../events');

const SCAN_MS = 60 * 1000;
const REFRESH_MS = 60 * 60 * 1000;
const SLUG_RE = /^[A-Za-z0-9_-]{1,80}$/;
// A Search document id starts with a letter or digit (search.index-document@1): a paste whose slug starts
// with '-' or '_' is indexed as paste_<row id> instead.
const DOC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const pasteDocId = (p) => (DOC_ID_RE.test(String(p.slug || '')) ? p.slug : `paste_${p.id}`);

const iso = (v) => {
    if (!v) return null;
    const d = new Date(String(v).includes('T') ? v : `${String(v).replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// Enough of Markdown gone for a summary: code fences, images, link targets, emphasis and heading marks.
const plain = (md) => String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/[*_~`]+/g, '');
const AUTHORSHIP = { ai: 'ai_generated', imported: 'imported', discord: 'imported' };
const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 32);
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function createSearchDocuments({ db }) {
    const stats = { sent: 0, tombstones: 0, unchanged: 0, lastError: null, lastScanAt: null };
    let lastScan = null;
    let timers = [];

    db.exec(`CREATE TABLE IF NOT EXISTS search_doc_pushes (
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        hash TEXT NOT NULL,
        revision INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (type, id)
    )`);
    const enabled = () => !!events.status().enabled;

    /** The document for one thread, `{ deleted: true }` when Search must not hold it. */
    function threadDocument(threadId) {
        const t = db.prepare(`SELECT t.*, s.slug AS space_slug, s.name AS space_name, s.visibility AS space_visibility,
                                     s.members_only_owner AS space_members_only, c.slug AS category_slug
                              FROM threads t JOIN spaces s ON s.id = t.space_id LEFT JOIN categories c ON c.id = t.category_id
                              WHERE t.id = ?`).get(threadId);
        if (!t || t.deleted_at || t.space_visibility !== 'public' || t.space_members_only || t.members_only_owner) return { deleted: true };
        const posts = db.prepare('SELECT body_markdown, is_opening FROM posts WHERE thread_id = ? AND deleted_at IS NULL ORDER BY is_opening DESC, id ASC').all(t.id);
        const opening = posts.find((p) => p.is_opening);
        const facets = { space: t.space_slug, kind: t.kind || 'discussion', replies: Number(t.reply_count) || 0, score: Number(t.score) || 0 };
        if (t.status) facets.status = String(t.status).slice(0, 200);
        if (t.category_slug) facets.category = t.category_slug;
        if (t.crosspost_of) facets.crosspost = true;
        const doc = {
            owner: 'community', type: 'thread', id: String(t.id), deleted: false, visibility: 'public',
            canonical_url: `${config.baseUrl}/s/${encodeURIComponent(t.space_slug)}/t/${encodeURIComponent(t.slug)}`,
            title: clean(t.title, 500) || 'Thread',
            summary: clean(plain(opening && opening.body_markdown), 300) || `A thread in ${t.space_name} on OpenVibe.Community.`,
            body: posts.map((p) => clean(plain(p.body_markdown), 8000)).filter(Boolean).join('\n').slice(0, 40000),
            facets, authorship: AUTHORSHIP[t.origin] || 'human', publication_state: 'published',
            published_at: iso(t.created_at), updated_at: iso(t.last_activity_at || t.created_at),
            indexability: t.crosspost_of ? { decision: 'noindex', reasons: ['crosspost'] } : { decision: 'index' },
        };
        if (!doc.body) delete doc.body;
        if (!doc.updated_at) delete doc.updated_at;
        return doc;
    }

    /** The document for one paste (by row), `{ deleted: true }` when Search must not hold it. */
    function pasteDocument(p) {
        if (!p || p.deleted_at || p.visibility !== 'public' || Number(p.burn_after_read)) return { deleted: true };
        let tags = [];
        try { tags = (JSON.parse(p.ai_tags || '[]') || []).filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)).slice(0, 50); } catch { /* none */ }
        const shot = p.type === 'screenshot';
        const facets = { kind: shot ? 'screenshot' : 'paste', views: Number(p.views) || 0, likes: Number(p.likes) || 0 };
        if (!shot && p.language) facets.syntax = String(p.language).slice(0, 200);
        if (tags.length) facets.tags = tags;
        const doc = {
            owner: 'community', type: 'paste', id: pasteDocId(p), deleted: false, visibility: 'public',
            canonical_url: `${config.baseUrl}/p/${encodeURIComponent(p.slug)}`,
            title: clean(p.title, 500) || (shot ? 'Screenshot' : 'Untitled'),
            summary: clean(p.ai_summary, 4000) || clean(shot ? '' : p.content, 300) || `A ${shot ? 'screenshot' : 'paste'} on OpenVibe.Community.`,
            body: shot ? clean(p.ai_summary, 8000) : String(p.content || '').slice(0, 40000),
            facets, authorship: AUTHORSHIP[p.origin] || 'human', publication_state: 'published',
            published_at: iso(p.created_at), updated_at: iso(p.updated_at || p.created_at),
            indexability: Number(p.is_nsfw) ? { decision: 'noindex', reasons: ['sensitive'] } : { decision: 'index' },
        };
        if (!doc.body) delete doc.body;
        return doc;
    }

    /** Send one document or tombstone when it changed. → 'sent' | 'tombstone' | 'unchanged' | 'skipped' */
    function send(type, id, doc) {
        if (!enabled()) return 'skipped';
        const prev = db.prepare('SELECT hash, revision, deleted FROM search_doc_pushes WHERE type = ? AND id = ?').get(type, id);
        if (doc.deleted && (!prev || prev.deleted)) { stats.unchanged++; return 'unchanged'; }   // never sent, or already gone
        const hash = doc.deleted ? 'deleted' : hashOf(doc);
        if (prev && prev.hash === hash) { stats.unchanged++; return 'unchanged'; }
        const revision = (prev ? prev.revision : 0) + 1;
        db.transaction(() => {
            if (doc.deleted) events.record('community.index_document.deleted', { type, id, revision }, { type, id, revision });
            else events.record('community.index_document.upserted', { type, id, revision }, { ...doc, revision });
            db.prepare(`INSERT INTO search_doc_pushes (type, id, hash, revision, deleted, pushed_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(type, id) DO UPDATE SET hash = excluded.hash, revision = excluded.revision, deleted = excluded.deleted, pushed_at = excluded.pushed_at`)
                .run(type, id, hash, revision, doc.deleted ? 1 : 0);
        })();
        if (doc.deleted) { stats.tombstones++; return 'tombstone'; }
        stats.sent++;
        return 'sent';
    }

    const publishThread = (threadId) => send('thread', String(threadId), threadDocument(threadId));
    function publishPaste(row) {
        if (!row || !SLUG_RE.test(String(row.slug || ''))) return 'skipped';
        return send('paste', pasteDocId(row), pasteDocument(row));
    }
    const guard = (fn) => { try { fn(); } catch (err) { stats.lastError = err.message; } };

    function scan({ now = Date.now() } = {}) {
        if (!enabled()) return 0;
        const from = lastScan || sqlTime(now - 10 * 60 * 1000);
        const to = sqlTime(now);
        const threads = db.prepare('SELECT id FROM threads').all();
        for (const t of threads) guard(() => publishThread(t.id));
        const pastes = db.prepare('SELECT * FROM pastes WHERE (updated_at >= @from AND updated_at < @to) OR (deleted_at >= @from AND deleted_at < @to) OR (created_at >= @from AND created_at < @to)').all({ from, to });
        for (const p of pastes) guard(() => publishPaste(p));
        lastScan = to;
        stats.lastScanAt = new Date(now).toISOString();
        return threads.length + pastes.length;
    }

    function refresh() {
        if (!enabled()) return 0;
        const rows = db.prepare('SELECT * FROM pastes').all();
        const seen = new Set();
        for (const p of rows) { seen.add(pasteDocId(p)); guard(() => publishPaste(p)); }
        for (const r of db.prepare("SELECT id FROM search_doc_pushes WHERE type = 'paste' AND deleted = 0").all()) {
            if (seen.has(r.id)) continue;
            // An id Search could never accept (sent before paste_<id> existed): nothing to remove there.
            if (!DOC_ID_RE.test(r.id)) db.prepare("DELETE FROM search_doc_pushes WHERE type = 'paste' AND id = ?").run(r.id);
            else guard(() => send('paste', r.id, { deleted: true }));
        }
        return rows.length;
    }

    function start() {
        if (timers.length || !enabled() || process.env.COMMUNITY_SEARCH_DOCUMENTS === 'off') return false;
        const every = (ms, fn, first) => {
            const t0 = setTimeout(() => guard(fn), first); if (t0.unref) t0.unref();
            const t = setInterval(() => guard(fn), ms); if (t.unref) t.unref();
            timers.push(t0, t);
        };
        every(SCAN_MS, () => scan(), 45 * 1000);
        every(REFRESH_MS, () => refresh(), 2 * 60 * 1000);
        return true;
    }
    function stop() { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers = []; }

    return { threadDocument, pasteDocument, publishThread, publishPaste, scan, refresh, start, stop, stats: () => ({ ...stats }) };
}

module.exports = { createSearchDocuments };
