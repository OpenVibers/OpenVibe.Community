'use strict';

/**
 * Community's own database (SQLite, better-sqlite3).
 *
 * Community is the authority for pastes once PASTES_AUTHORITY=community: pastes, their edit
 * history, likes and comments live here. People are referenced by Network subject ids
 * (usr_… / gst_…), never by a service-local integer; subject_projection is only a display cache
 * of what the Network says about them.
 *
 * Schema creation is idempotent (CREATE … IF NOT EXISTS) and runs on open.
 */
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

CREATE TABLE IF NOT EXISTS import_hold (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (source_type, source_id, reason)
);
`;

/** Open (creating the directory and schema if needed). ':memory:' works for tests. */
function openDb(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    return db;
}

let _shared = null;
/** The process-wide database at COMMUNITY_DB_PATH (opened on first use). */
function getDb() {
    if (!_shared) _shared = openDb(require('./config').dbPath);
    return _shared;
}

module.exports = { openDb, getDb, SCHEMA };
