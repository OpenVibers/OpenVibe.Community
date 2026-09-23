'use strict';

/**
 * Community's own database (SQLite, better-sqlite3).
 *
 * Community is the authority for pastes once PASTES_AUTHORITY=community: pastes, their edit
 * history, likes and comments live here. Typed comment threads, the forum (spaces, threads,
 * posts), the Discord relay's bookkeeping and Pulse live here in every mode. People are referenced by Network subject ids
 * (usr_… / gst_…), never by a service-local integer; subject_projection is only a display cache
 * of what the Network says about them.
 *
 * Schema creation is idempotent (CREATE … IF NOT EXISTS) and runs on open.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pastes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    owner_subject TEXT,
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'ai', 'imported')),
    type TEXT NOT NULL DEFAULT 'paste' CHECK(type IN ('paste', 'screenshot')),
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT,
    language TEXT DEFAULT 'text',
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'unlisted', 'private')),
    screenshot_url TEXT,
    media_ref TEXT,
    stream_ref TEXT,                    -- JSON EntityRef, e.g. {"service":"live","type":"stream","id":"123"}
    metadata TEXT,                      -- JSON
    burn_after_read INTEGER NOT NULL DEFAULT 0,
    forked_from INTEGER REFERENCES pastes(id) ON DELETE SET NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    unique_views INTEGER NOT NULL DEFAULT 0,
    copies INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    is_nsfw INTEGER NOT NULL DEFAULT 0,
    ai_summary TEXT,
    ai_tags TEXT,                       -- JSON array
    ai_analyzed_at DATETIME,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    legacy_media_id INTEGER UNIQUE,
    legacy_user_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pastes_listing ON pastes(visibility, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pastes_owner ON pastes(owner_subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pastes_forked ON pastes(forked_from);

CREATE TABLE IF NOT EXISTS paste_versions (
    paste_id INTEGER NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    title TEXT,
    content TEXT,
    language TEXT,
    edited_by TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (paste_id, revision)
);

CREATE TABLE IF NOT EXISTS paste_likes (
    paste_id INTEGER NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (paste_id, subject_id)
);

CREATE TABLE IF NOT EXISTS paste_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paste_id INTEGER NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    author_subject TEXT,
    anon_name TEXT,
    parent_id INTEGER REFERENCES paste_comments(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    legacy_media_id INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_paste_comments_paste ON paste_comments(paste_id, parent_id);

-- Per-visitor view bookkeeping (cooldown + unique counts). Visitors are 'u:<subject>' or an
-- HMAC of the address ('ip:<hash>'); no raw addresses are stored.
CREATE TABLE IF NOT EXISTS paste_visits (
    paste_id INTEGER NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    visitor TEXT NOT NULL,
    first_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    visits INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (paste_id, visitor)
);
CREATE INDEX IF NOT EXISTS idx_paste_visits_last ON paste_visits(last_at);

CREATE TABLE IF NOT EXISTS subject_projection (
    subject_id TEXT PRIMARY KEY,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    profile_color TEXT,
    refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_subject_projection_username ON subject_projection(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS migration_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    report TEXT
);

CREATE TABLE IF NOT EXISTS legacy_id_map (
    source_system TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    PRIMARY KEY (source_system, source_type, source_id)
);

-- ── Typed comment threads (server/comments) ──────────────────
-- One thread per foreign entity (an EntityRef: service + type + id). Other products embed these
-- instead of owning comment tables. Paste comments stay in paste_comments.
CREATE TABLE IF NOT EXISTS comment_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_service TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    ref_label TEXT,                     -- cached display label from a service; never authoritative
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'hidden', 'locked')),
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,                    -- subject or service principal that first resolved it
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    access_id TEXT,                     -- unguessable handle for browsers (migrate() fills old rows, unique index)
    UNIQUE (ref_service, ref_type, ref_id)
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    author_subject TEXT,
    anon_name TEXT,
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'ai')),
    message TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    upvotes INTEGER NOT NULL DEFAULT 0,
    downvotes INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    deleted_by TEXT,
    edited_at DATETIME                  -- the author last changed the text (migrate() adds it to older databases)
);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(thread_id, parent_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id, id);

CREATE TABLE IF NOT EXISTS comment_votes (
    comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    value INTEGER NOT NULL CHECK(value IN (-1, 1)),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (comment_id, subject_id)
);

-- ── Forum: spaces / threads / posts (server/forum) ───────────
-- visibility: public (anyone reads, people post), members (signed-in people only), staff.
CREATE TABLE IF NOT EXISTS spaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'members', 'staff')),
    created_by TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO spaces (slug, name, description, visibility, created_by) VALUES
    ('general', 'General', 'Anything about OpenVibe and the people on it.', 'public', 'system'),
    ('feedback', 'Feedback', 'Feature requests, bugs and ideas for every OpenVibe site.', 'public', 'system'),
    ('showcase', 'Showcase', 'Show what you made: streams, clips, art, code, tools.', 'public', 'system');

-- origin: who wrote it — a person (user), AI output (never attributed to a person), a relay
-- from another platform (discord: never relayed back out), or the site itself (system).
CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    author_subject TEXT,
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'ai', 'discord', 'system')),
    pinned INTEGER NOT NULL DEFAULT 0,
    locked INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    reply_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    UNIQUE (space_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_threads_space_new ON threads(space_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_threads_author ON threads(author_subject, created_at DESC);

CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    author_subject TEXT,
    origin TEXT NOT NULL DEFAULT 'user' CHECK(origin IN ('user', 'ai', 'discord', 'system')),
    is_opening INTEGER NOT NULL DEFAULT 0,
    body_markdown TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_subject, created_at DESC);

CREATE TABLE IF NOT EXISTS post_versions (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    body_markdown TEXT NOT NULL,
    edited_by TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, revision)
);

CREATE TABLE IF NOT EXISTS thread_votes (
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    value INTEGER NOT NULL CHECK(value IN (-1, 1)),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (thread_id, subject_id)
);

-- ── Discord relay (server/relay; DISCORD_RELAY_ENABLED) ──────
-- webhook_url_ref is the NAME of an environment variable holding the webhook URL: secrets never
-- live in the database.
CREATE TABLE IF NOT EXISTS relay_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out')),
    webhook_url_ref TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (space_id, direction, webhook_url_ref)
);

-- One delivery per (thread, mapping): the dedupe key. status pending → delivered | failed.
CREATE TABLE IF NOT EXISTS relay_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    mapping_id INTEGER NOT NULL REFERENCES relay_mappings(id) ON DELETE CASCADE,
    dedupe_key TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_status INTEGER,
    last_error TEXT,
    delivered_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (thread_id, mapping_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_deliveries_due ON relay_deliveries(status, next_attempt_at);

-- ── Pulse (server/pulse): public activity across the network, with provenance ──
-- Only public things enter; AI items carry origin 'ai' and never an actor.
CREATE TABLE IF NOT EXISTS pulse_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_service TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    actor_subject TEXT,
    origin TEXT NOT NULL CHECK(origin IN ('user', 'ai', 'system')),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public')),
    occurred_at DATETIME NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_service, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_pulse_recent ON pulse_items(occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_pulse_origin ON pulse_items(origin, occurred_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS import_hold (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_type, source_id, reason)
);
`;

/**
 * SQL functions every connection needs (worker connections in tests too).
 *
 *   ov_hot(score, age_hours) — the forum's "hot" rank. Deterministic: the same score and age
 *   always give the same number, and callers pass one `now` for a whole page, so a page is
 *   ranked against a single instant:
 *
 *       hot = (score + 1) / (age_hours + 2) ^ 1.5
 *
 *   +1 lets a thread nobody voted on yet still rank by age (instead of all tying at 0); +2 hours
 *   keeps a brand-new thread from dividing by ~0; the 1.5 exponent is the Hacker News gravity.
 */
function registerFunctions(db) {
    db.function('ov_hot', { deterministic: true }, (score, ageHours) => (Number(score || 0) + 1) / Math.pow(Math.max(Number(ageHours) || 0, 0) + 2, 1.5));
}

/** Open (creating the directory and schema if needed). ':memory:' works for tests. */
function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    migrate(db);
    registerFunctions(db);
    return db;
}

/**
 * Additive changes to tables that already exist (CREATE TABLE IF NOT EXISTS never alters one).
 * Idempotent: every boot checks and fills in only what is missing.
 *
 *   comment_threads.access_id — the unguessable handle browsers address a thread by (128 random
 *   bits); the sequential id is for services only, so threads cannot be enumerated. Threads made
 *   before the column existed get one here.
 *   comments.edited_at — when the author last edited the text (null: never edited).
 *   spaces.members_only_owner, threads.members_only_owner — members-only for a creator's OpenVibe.VIP
 *   members (their Network subject); NULL: not gated. See forum/service.js.
 */
function migrate(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(comment_threads)').all().map((c) => c.name));
    if (!cols.has('access_id')) db.exec('ALTER TABLE comment_threads ADD COLUMN access_id TEXT');
    const missing = db.prepare('SELECT id FROM comment_threads WHERE access_id IS NULL').all();
    if (missing.length) {
        const set = db.prepare('UPDATE comment_threads SET access_id = ? WHERE id = ?');
        db.transaction(() => { for (const r of missing) set.run(newThreadAccessId(), r.id); })();
    }
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_threads_access ON comment_threads(access_id)');
    const commentCols = new Set(db.prepare('PRAGMA table_info(comments)').all().map((c) => c.name));
    if (!commentCols.has('edited_at')) db.exec('ALTER TABLE comments ADD COLUMN edited_at DATETIME');
    // Members-only (OpenVibe.VIP): the creator (usr_…) whose members may read and post.
    for (const table of ['spaces', 'threads']) {
        const c = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((x) => x.name));
        if (!c.has('members_only_owner')) db.exec(`ALTER TABLE ${table} ADD COLUMN members_only_owner TEXT`);
    }
}

/** cth_ + 22 base64url characters (16 random bytes). */
function newThreadAccessId() { return `cth_${crypto.randomBytes(16).toString('base64url')}`; }

let _shared = null;
/** The process-wide database at COMMUNITY_DB_PATH (opened on first use). */
function getDb() {
    if (!_shared) _shared = openDb(require('./config').dbPath);
    return _shared;
}

module.exports = { openDb, getDb, registerFunctions, SCHEMA, newThreadAccessId };
