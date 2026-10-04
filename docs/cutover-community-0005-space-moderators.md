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

- Ship it with the normal pipeline (`ov deploy OpenVibe.Community`). It needs no window.
- N-1: the previous release runs against the new schema throughout the mixed-version window. It
  ignores the table, so its moderation is still global-only until every process runs the new release.

## 1. Rehearsal

1. Restore a recent copy of `ov_community` into a scratch database (the restore-drill copy will do).
2. Boot this release against it (`DATABASE_URL`/`DATABASE_DIRECT_URL` pointing at the copy), or run
   `npm run test:pg` with the copy as the test store. Check that `ov_migrations` lists `0005` and that
   `\d space_moderators` shows the primary key `(space_id, subject_id)`, the foreign key to `spaces`
   (`ON DELETE CASCADE`) and `idx_space_moderators_subject`.
3. Run the moderator tests: `ov test space-moderators forum members-only security-idor chat-room`.

## 2. Cutover

1. Deploy. The migration runs at the first boot of the new release.
2. **Verify:**
   - `ov access run openvibe-ovh health community` is green.
   - `ov access run openvibe-ovh journal openvibe-community.service 200` shows `0005_space_moderators`
     applied and no migrate error.
   - `curl -s https://openvibe.community/api/v1/spaces/general/moderators` answers
     `{ "space": "general", "moderators": [] }`.

## 3. Rollback

Leave the table where it is. A rollback to the previous release ignores it. Rows added in the meantime
stay, and they apply again when the release comes back. The migration is never reverted or edited
(`ov_migrations` keeps its checksum). If it must be undone by hand, a later contract migration drops the
table after the N-1 window.

## 4. Afterwards

- Account deletion erases a person's rows, and `added_by` becomes NULL where they added someone. A
  subject merge moves the rows (`server/identity/account-data.js`, `subject-merge.js`).
- When the forum moves to OpenVibe.Space (T10 step 3), `space_moderators` moves with the forum tables.
