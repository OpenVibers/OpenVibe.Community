# OpenVibe.Community

OpenVibe.Community serves pastes, embedded comment threads, Pulse, and submissions at [openvibe.community](https://openvibe.community). It is a Node/Express service with PostgreSQL, an embedded PGlite development store, and server-rendered pages.

## Forum

The forum now lives at [OpenVibe.Space](https://openvibe.space).

## What Community owns

- Pastes: text and screenshots, versions, likes, comments, forks, and burn-after-read. Community is the paste authority; screenshot bytes live in OpenVibe.Media.
- Typed comment threads: `/api/v1/comments/*` and `/c/:accessId`. Other products embed the same thread, identified by an EntityRef. Community paste refs are `community/paste/<slug>`.
- Pulse: `/pulse` and `/api/v1/pulse/*` for public activity from Community and other OpenVibe services.
- Submissions: `/submissions` and `/api/v1/submissions/*` for clips, art, ideas, and reports sent for review.
- Network identity projections, blocks, revocation, account export and deletion, and subject merge handling.
- Paste Search documents and `community.*` events through the Events outbox.

## Routes

| Route | Purpose |
| --- | --- |
| `/`, `/pastes`, `/p/:slug`, `/new`, `/my` | Paste pages and forms |
| `/api/pastes/*` | Native paste API |
| `/c/:accessId`, `/api/v1/comments/*` | Embedded comment threads |
| `/pulse`, `/api/v1/pulse/*` | Public activity |
| `/submissions/*`, `/api/v1/submissions/*` | Submissions and review |
| `/search` | Search Community pastes |
| `/s`, `/s/*` | 301 redirect to OpenVibe.Space, preserving path and query |
| `/feed.xml`, `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt` | Paste and site discovery |
| `/api/health`, `/api/ready`, `/metrics`, `/release.json` | Operations |

A comment thread opens when an entity is first resolved. Browsers use its unguessable `cth_…` access ID; services may use its numeric ID. Community checks paste visibility on each comment read and write. A private, deleted, or burned paste never exposes its comments to an unauthorized viewer. Other products control access to their own entity refs. Comment votes are per person, and hidden or locked threads follow the comment service's moderation rules.

## Storage and migrations

`migrations/` is applied by `openvibe-sdk/db` at boot. Never edit an applied migration. `DATABASE_DIRECT_URL` is the owner connection for PostgreSQL migrations; `DATABASE_URL` is the serving connection through PgBouncer. With neither set, development uses embedded PGlite. Valkey shares per-actor limit counters when configured.

`0006_contract_forum.sql` is the destructive contract step for the Space move. It is marked `-- phase: contract` and `-- after: 0005`; the database runner holds it until its seven-day rollback window has passed. It drops the former forum and Discord relay tables and their indexes. Pastes, comments, Pulse, submissions, `network_blocks`, `account_data_events`, and `subject_projection` remain.

## Configuration

Copy `.env.example` to `.env` for local development. Set the Network OAuth client, Media address, database URLs, Events URL and secret, and Search address for the features you use. Public pages work without a database URL in development through PGlite. In production, use PostgreSQL and the service's registered Network OAuth client.

## Development

Run `npm start` after installing dependencies. Use `ov test <files>` for targeted suites; CI runs the full suite. The test helper creates a migrated PGlite database by default. Tests that boot an HTTP server require local loopback listeners.

<!-- versions:start -->
- openvibe-contracts: v0.112.0
- openvibe-sdk: v0.35.0
- openvibe-shared: v2.13.0
<!-- versions:end -->
