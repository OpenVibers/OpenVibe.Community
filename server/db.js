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

// relay_deliveries' columns: the table in SCHEMA, and migrate()'s one-time rebuild of the older shape.
const RELAY_DELIVERIES_COLUMNS = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    mapping_id INTEGER NOT NULL REFERENCES relay_mappings(id) ON DELETE CASCADE,
    action TEXT NOT NULL DEFAULT 'create' CHECK(action IN ('create', 'edit', 'delete')),
    dedupe_key TEXT UNIQUE NOT NULL,
    source TEXT NOT NULL DEFAULT 'direct' CHECK(source IN ('direct', 'events')),
    event_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'failed', 'dropped', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_status INTEGER,
    last_error TEXT,
    delivered_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
`;

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

-- Images attached to forum posts (WS-J task 2): the bytes are a Media object (med_…, tenant community,
-- owned by the person); an upload waits here with no post until the thread or reply naming it is saved.
CREATE TABLE IF NOT EXISTS attachments (
    media_id TEXT PRIMARY KEY,
    owner_subject TEXT NOT NULL,
    post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    filename TEXT,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    url TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_post ON attachments(post_id, position) WHERE post_id IS NOT NULL;

-- The board index (forum style): spaces are listed under groups, like a vBulletin/SMF board index.
CREATE TABLE IF NOT EXISTS space_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

-- Facepunch-style ratings on posts: one per person per post (forum/reactions.js lists them).
CREATE TABLE IF NOT EXISTS post_reactions (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    reaction TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (post_id, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_post_reactions_post ON post_reactions(post_id, reaction);

-- Pastes attached to posts (a card with the paste's first lines, or its screenshot).
CREATE TABLE IF NOT EXISTS post_pastes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    paste_id INTEGER NOT NULL REFERENCES pastes(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (post_id, paste_id)
);

-- Categories inside a space (WS-J task 1): threads may carry one; the space page filters by them.
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (space_id, slug)
);

-- ── Discord relay (server/relay; DISCORD_RELAY_ENABLED) ──────
-- webhook_url_ref is the NAME of an environment variable holding the webhook URL: secrets never
-- live in the database. migrate() adds discord_channel_id (the channel the webhook posts into;
-- learned from Discord's answer when unset), discord_thread_id (post into this Discord thread) and
-- inbound (replies from Discord come back as posts).
CREATE TABLE IF NOT EXISTS relay_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out')),
    webhook_url_ref TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (space_id, direction, webhook_url_ref)
);

-- One outbound action per dedupe key (WS-J task 6): send a thread's or a reply's Discord message
-- (create), edit it or delete it. post_id NULL: the thread's own message. source: queued by the
-- Events worker from community.thread.* / community.post.* (event_id), or directly by the forum.
-- status pending → delivered | failed (the dead letter: retries used up, or refused; staff retry or
-- drop it) | dropped (by staff) | skipped (nothing left to do, e.g. deleted before it was sent).
CREATE TABLE IF NOT EXISTS relay_deliveries (${RELAY_DELIVERIES_COLUMNS});
CREATE INDEX IF NOT EXISTS idx_relay_deliveries_due ON relay_deliveries(status, next_attempt_at);

-- External message map (WS-J task 5): every Discord message the relay knows, both ways.
--   out  a thread (local_type 'thread': title and opening post) or a reply sent through the mapping's webhook
--   in   a reply written on Discord, now a post with origin 'discord' (local_type 'post')
-- external_channel_id is where the message is (a Discord thread's id for one in a thread);
-- external_thread_id is set when the relay sent it into a Discord thread (edits and deletes name it).
-- Unique both ways: a Discord message is one local object; a local object is one message per mapping.
-- Edits and deletes on either side find their counterpart here.
CREATE TABLE IF NOT EXISTS relay_message_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'discord' CHECK(platform IN ('discord')),
    mapping_id INTEGER NOT NULL REFERENCES relay_mappings(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK(direction IN ('out', 'in')),
    local_type TEXT NOT NULL CHECK(local_type IN ('thread', 'post')),
    local_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    external_channel_id TEXT NOT NULL,
    external_thread_id TEXT,
    external_message_id TEXT NOT NULL,
    external_webhook_id TEXT,
    external_deleted_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (platform, external_message_id),
    UNIQUE (platform, mapping_id, local_type, local_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_message_map_thread ON relay_message_map(thread_id);

-- The relay's Events worker's place in OpenVibe.Events (server/relay/events-worker.js): the last seq
-- it handled, moved in the same transaction as the deliveries that page queued.
CREATE TABLE IF NOT EXISTS relay_cursors (
    name TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL,
    latest_seq INTEGER,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Messages from Discord that did not become (or change) a post, for staff (GET /api/v1/relay/inbound).
-- Ids and the reason only, never the text.
CREATE TABLE IF NOT EXISTS relay_inbound_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mapping_id INTEGER REFERENCES relay_mappings(id) ON DELETE SET NULL,
    event TEXT NOT NULL,
    external_channel_id TEXT,
    external_message_id TEXT,
    external_author_id TEXT,
    error TEXT NOT NULL,
    dismissed_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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
    // Categories, feature requests and the roadmap (WS-J tasks 1 and 8; forum/service.js):
    //   spaces.thread_kind  what a new thread in the space is: discussion, request (votes and a status set
    //                       by staff) or roadmap (staff and the roadmap sync only; forum/roadmap.js)
    //   threads.kind/status/category_id/external_key  the thread's kind, its status for requests and roadmap
    //                       items, its category, and the roadmap item key it was synced from
    const spaceCols = new Set(db.prepare('PRAGMA table_info(spaces)').all().map((x) => x.name));
    if (!spaceCols.has('thread_kind')) db.exec("ALTER TABLE spaces ADD COLUMN thread_kind TEXT NOT NULL DEFAULT 'discussion'");
    const threadCols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((x) => x.name));
    if (!threadCols.has('kind')) db.exec("ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'discussion'");
    if (!threadCols.has('status')) db.exec('ALTER TABLE threads ADD COLUMN status TEXT');
    if (!threadCols.has('category_id')) db.exec('ALTER TABLE threads ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL');
    if (!threadCols.has('external_key')) db.exec('ALTER TABLE threads ADD COLUMN external_key TEXT');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_external_key ON threads(space_id, external_key) WHERE external_key IS NOT NULL;
             CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category_id) WHERE category_id IS NOT NULL;
             INSERT OR IGNORE INTO spaces (slug, name, description, visibility, created_by, thread_kind) VALUES
                 ('roadmap', 'Roadmap', 'What OpenVibe is building next and where each piece stands. Every item has its own thread: ask about it or argue for it there.', 'public', 'system', 'roadmap');
             UPDATE spaces SET thread_kind = 'request', description = 'Feature requests, bugs and ideas for every OpenVibe site. Vote for what matters to you; staff mark what is planned and done.'
                 WHERE slug = 'feedback' AND thread_kind = 'discussion' AND created_by = 'system';`);
    // Space styles (forum/service.js): 'feed' (subreddit-like: votes, hot/new/top) or 'forum' (vBulletin/SMF-like:
    // board index, topics by last post, author panels, quotes). Votes and ratings are per-space switches;
    // group_id and position place a space on the board index, parent_id makes it a child board.
    for (const [col, ddl] of [['style', "TEXT NOT NULL DEFAULT 'feed'"], ['votes', 'INTEGER NOT NULL DEFAULT 1'], ['reactions', 'INTEGER NOT NULL DEFAULT 1'],
        ['group_id', 'INTEGER REFERENCES space_groups(id) ON DELETE SET NULL'], ['parent_id', 'INTEGER REFERENCES spaces(id) ON DELETE SET NULL'], ['position', 'INTEGER NOT NULL DEFAULT 0']]) {
        if (!spaceCols.has(col)) db.exec(`ALTER TABLE spaces ADD COLUMN ${col} ${ddl}`);
    }
    if (!threadCols.has('views')) db.exec('ALTER TABLE threads ADD COLUMN views INTEGER NOT NULL DEFAULT 0');
    if (!threadCols.has('crosspost_of')) db.exec('ALTER TABLE threads ADD COLUMN crosspost_of INTEGER REFERENCES threads(id) ON DELETE SET NULL');
    // The first board index: two groups, the four original spaces placed once (a space staff moved is left alone),
    // and two new forum boards.
    db.exec(`INSERT OR IGNORE INTO space_groups (slug, name, description, position) VALUES
                 ('openvibe', 'OpenVibe', 'The network itself: talk, help, requests and what is coming next.', 1),
                 ('community', 'Community', 'What the people of OpenVibe make, and everything else.', 2);
             INSERT OR IGNORE INTO spaces (slug, name, description, visibility, created_by, style, votes) VALUES
                 ('help', 'Help', 'Stuck on something? Ask here: streaming, tools, your account, anything on OpenVibe.', 'public', 'system', 'forum', 0),
                 ('off-topic', 'Off-topic', 'Anything that is not about OpenVibe.', 'public', 'system', 'forum', 0);`);
    const place = db.prepare(`UPDATE spaces SET group_id = (SELECT id FROM space_groups WHERE slug = ?), position = ?, style = ?, votes = ?
                              WHERE slug = ? AND created_by = 'system' AND group_id IS NULL`);
    for (const [group, position, style, votes, slug] of [
        ['openvibe', 1, 'forum', 0, 'general'], ['openvibe', 2, 'forum', 0, 'help'], ['openvibe', 3, 'feed', 1, 'feedback'], ['openvibe', 4, 'feed', 1, 'roadmap'],
        ['community', 1, 'feed', 1, 'showcase'], ['community', 2, 'forum', 0, 'off-topic'],
    ]) place.run(group, position, style, votes, slug);
    const seedCategory = db.prepare(`INSERT OR IGNORE INTO categories (space_id, slug, name, description, position)
                                     SELECT id, ?, ?, ?, ? FROM spaces WHERE slug = ?`);
    for (const [space, slug, name, description, position] of [
        ['feedback', 'ideas', 'Ideas', 'Something new, or something better.', 1],
        ['feedback', 'bugs', 'Bugs', 'Something is broken or wrong.', 2],
        ['feedback', 'questions', 'Questions', 'How do I…? Why does…?', 3],
        ['roadmap', 'launches', 'New sites', 'Sites that open next.', 1],
        ['roadmap', 'features', 'Features', 'New things on sites that are already open.', 2],
        ['roadmap', 'platform', 'Under the hood', 'Accounts, safety, reliability and the shared systems every site uses.', 3],
    ]) seedCategory.run(slug, name, description, position, space);
    // The Discord relay both ways (WS-J tasks 5 and 6; server/relay): where a mapping's webhook posts and
    // whether replies come back, the Discord name on posts from Discord, and relay_deliveries rebuilt once
    // for replies, edits and deletes (the older table allowed one row per (thread, mapping) and no actions).
    const mappingCols = new Set(db.prepare('PRAGMA table_info(relay_mappings)').all().map((x) => x.name));
    if (!mappingCols.has('discord_channel_id')) db.exec('ALTER TABLE relay_mappings ADD COLUMN discord_channel_id TEXT');
    if (!mappingCols.has('discord_thread_id')) db.exec('ALTER TABLE relay_mappings ADD COLUMN discord_thread_id TEXT');
    if (!mappingCols.has('inbound')) db.exec('ALTER TABLE relay_mappings ADD COLUMN inbound INTEGER NOT NULL DEFAULT 0');
    const postCols = new Set(db.prepare('PRAGMA table_info(posts)').all().map((x) => x.name));
    if (!postCols.has('relay_author')) db.exec('ALTER TABLE posts ADD COLUMN relay_author TEXT');
    const deliveryCols = new Set(db.prepare('PRAGMA table_info(relay_deliveries)').all().map((x) => x.name));
    if (!deliveryCols.has('action')) {
        db.transaction(() => {
            db.exec(`CREATE TABLE relay_deliveries_v2 (${RELAY_DELIVERIES_COLUMNS});
                     INSERT INTO relay_deliveries_v2 (id, thread_id, mapping_id, dedupe_key, status, attempts, next_attempt_at, last_status, last_error, delivered_at, created_at, updated_at)
                         SELECT id, thread_id, mapping_id, dedupe_key, status, attempts, next_attempt_at, last_status, last_error, delivered_at, created_at, updated_at FROM relay_deliveries;
                     DROP TABLE relay_deliveries;
                     ALTER TABLE relay_deliveries_v2 RENAME TO relay_deliveries;
                     CREATE INDEX IF NOT EXISTS idx_relay_deliveries_due ON relay_deliveries(status, next_attempt_at);`);
        })();
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_deliveries_thread ON relay_deliveries(thread_id, post_id);
             CREATE INDEX IF NOT EXISTS idx_relay_mappings_channel ON relay_mappings(discord_channel_id) WHERE discord_channel_id IS NOT NULL;`);
}

/** cth_ + 22 base64url characters (16 random bytes). */
function newThreadAccessId() { return `cth_${crypto.randomBytes(16).toString('base64url')}`; }

let _shared = null;
/** The process-wide database at COMMUNITY_DB_PATH (opened on first use). */
function getDb() {
    if (!_shared) _shared = openDb(require('./config').dbPath);
    return _shared;
}

/** Graceful stop: close the process-wide database (a later getDb() opens it again). */
function closeDb() {
    const db = _shared;
    _shared = null;
    if (db) try { db.close(); } catch { /* already closed */ }
}

module.exports = { openDb, getDb, closeDb, registerFunctions, SCHEMA, newThreadAccessId };
