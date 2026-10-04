# Cutover runbook: Community migration 0005 (per-space moderators)

T10 step 1. `migrations/0005_space_moderators.sql` adds one table, `space_moderators`, and its index. A
person listed there for a space moderates that space (see README, "Forum"). Nothing existing is
changed, and the previous release never reads the table.

## Overview

| | |
|---|---|
| Migration | `0005_space_moderators.sql`, `-- phase: migrate`, additive (CREATE TABLE + CREATE INDEX) |
| Applied | At boot, by `server/db.js` (openvibe-sdk/db migrate, owner role on `DATABASE_DIRECT_URL`), in one transaction under the advisory lock |
| Data moved | None. The table starts empty. Staff add the first moderators per space |
| Env / config | None. No new capability and no Contracts change: a space moderator is a data row |
| Owner action | None for the deploy. Afterwards, staff add moderators with `PUT /api/v1/spaces/:space/moderators/:subject` or the space page's form |

## 0. Rules

- This is the one runbook of PR #15. Ship it with the normal pipeline (`ov deploy OpenVibe.Community`).
  It needs no window.
- N-1: the previous release runs against the new schema throughout the mixed-version window. It
  ignores the table, so its moderation is still global-only until every process runs the new release.
- Order: rehearsal (section 1) → backup (section 2) → deploy and verify (section 3).

## 1. Rehearsal

The harness runs `ov rehearse OpenVibe.Community 15` on a scratch PostgreSQL: main's migrations, the
repository's fixtures, this PR's migrations (a second run must apply nothing), then the commands below,
each with `DATABASE_URL` on that database. They check the table's columns, the index, and that deleting
a space removes its moderator rows.

```rehearse
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM information_schema.columns WHERE table_name = 'space_moderators'" | grep -qx 4
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_space_moderators_subject'" | grep -qx 1
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM space_moderators" | grep -qx 0
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "WITH s AS (INSERT INTO spaces (slug, name) VALUES ('rehearse-moderators', 'Rehearsal') RETURNING id), m AS (INSERT INTO space_moderators (space_id, subject_id, added_by) SELECT id, 'usr_rehearse', 'usr_staff' FROM s RETURNING 1) SELECT count(*) FROM m" | grep -qx 1
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DELETE FROM spaces WHERE slug = 'rehearse-moderators'"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "SELECT count(*) FROM space_moderators" | grep -qx 0
```

Beyond the harness, against a restored copy of `ov_community` (the restore-drill copy), run
`ov test space-moderators forum members-only security-idor chat-room`, or `npm run test:pg`.

## 2. Backup

Before the deploy, take a custom-format dump of the production database and keep it until the N-1 window
has closed:

```
pg_dump --format=custom --file=ov_community-pre-0005.dump "$DATABASE_DIRECT_URL"
pg_restore --list ov_community-pre-0005.dump | head
```

The migration only adds a table, so the dump is the safety net for the whole database, not for a
particular row change.

## 3. Cutover

1. Deploy. The migration runs at the first boot of the new release.
2. **Verify:**
   - `ov access run openvibe-ovh health community` is green.
   - `ov access run openvibe-ovh journal openvibe-community.service 200` shows `0005_space_moderators`
     applied and no migrate error.
   - `curl -s https://openvibe.community/api/v1/spaces/general/moderators` answers
     `{ "space": "general", "moderators": [] }`.
   - `psql "$DATABASE_DIRECT_URL" -c '\d space_moderators'` shows the primary key
     `(space_id, subject_id)`, the foreign key to `spaces` (`ON DELETE CASCADE`) and
     `idx_space_moderators_subject`.

## 4. Rollback and restore

Code rollback (the normal way back): redeploy the previous release and leave the table where it is. The
previous release ignores it. Rows added in the meantime stay, and they apply again when the release comes
back. The migration is never reverted or edited (`ov_migrations` keeps its checksum).

Undoing the schema by hand (only if the table itself is the problem): redeploy the previous release
first, then `DROP TABLE space_moderators;` (the index goes with it). Otherwise a later contract
migration drops the table after the N-1 window.

Restore (only if the database is damaged, which this migration cannot cause): stop the service,
`pg_restore --clean --if-exists --dbname="$DATABASE_DIRECT_URL" ov_community-pre-0005.dump`, start the
previous release, and repeat the health and journal checks. Moderators added after the backup are lost by
a restore, so prefer the code rollback.

## 5. Afterwards

- Account deletion erases a person's rows, and `added_by` becomes NULL where they added someone. A
  subject merge moves the rows (`server/identity/account-data.js`, `subject-merge.js`).
- When the forum moves to OpenVibe.Space (T10 step 3), `space_moderators` moves with the forum tables.
