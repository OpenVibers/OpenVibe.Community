# OpenVibe.Community

**https://openvibe.community — the people of OpenVibe.**

The community hub of the OpenVibe network: community-run, open source, free speech within
the rules. It is the home of **pastes** (code, text and screenshots with a link), the
**forum** (spaces, threads and posts), the **comment threads** every other OpenVibe product
embeds, and **Pulse**, the network's public activity. Submissions follow.

It is a small Node/Express app (CommonJS, no framework, one SQLite database) that
server-renders every page — crawlers and no-JS readers get the whole thing — and adds a
little progressive JavaScript for pagination, copy buttons and the upload path.

## How it fits the network

Pastes moved to Community in roadmap Wave 5. `PASTES_AUTHORITY` picks who owns them:

- **`live`** (the code default, now the rollback mode): the table below.
- **`community`** (production since 2026-09-22, about 23:35 UTC): Community's own database is
  the authority — see [Community as the paste authority](#community-as-the-paste-authority).
  The import brought 889 + 2 pastes, 60 comments and 48 likes; 5 rows (1 paste, 4 comments,
  `ambiguous_owner`) wait in `import_hold`. Live and Tools forward paste writes here, and Media
  answers old paste URLs with a 301 to this site. Comments, the forum and Pulse are deployed but
  hold almost nothing yet (10 wiki comment threads, 0 forum threads), and the Discord relay is
  off. A restore drill passed on 2026-09-23.

| Concern | Where it lives | How Community reaches it |
| --- | --- | --- |
| Paste storage | **OpenVibe.Media** (`pastes` table, `/api/v1/:app/pastes`) | never directly |
| Paste API + account mapping | **OpenVibe.Live** (`/api/pastes/*`) | `OV_LIVE_INTERNAL_URL` (server-side) |
| Identity / SSO | **OpenVibe.Network** (OAuth2 + RS256 JWKS) | OAuth client `community` |
| Raw text, screenshots | OpenVibe.Media public host | 302 from `/p/:slug/raw`, `/p/:slug/screenshot` |
| Shared chrome, themes | `https://openvibe.network/shared/*.js` | loaded in every page |
| VIP memberships (members-only spaces/threads) | **OpenVibe.VIP** (`POST /api/v1/policies/evaluate`) | `OV_VIP_INTERNAL_URL`, service token (audience `openvibe.vip`, `vip.resource.policy.evaluate`) |

Why go through Live and not straight to Media: the visitor's JWT names the account by its
**Network** id, while the `user_id` Media stores for pastes is **Live's** own — different
numbers for the same person. Live resolves the visitor against its own accounts before it
writes, which only Live can do, so Community proxies `/api/pastes/*` to Live and forwards the
visitor's `Authorization: Bearer <network jwt>` (or `ov_token` cookie). Creation, listing,
anonymous-post limits, ownership and author names are therefore identical to Live's.

### Community as the paste authority

With `PASTES_AUTHORITY=community`, `/api/pastes/*` is Community's native API
(`server/pastes/api.js` → `service.js` → `store.js`) with the paths, bodies, status codes and
response shapes the browser clients already use, and every page, `/p/:slug/raw`,
`/p/:slug/screenshot` and `/p/:slug/download` reads from the store (never from Media, which
redirects its old paste URLs here after cutover). The list (`GET /api/pastes`) also takes
`origin=user|ai` (people's pastes or AI output), `sort=newest|oldest|top` (`top`: views, a like
worth five), `since=` (created at or after; ISO 8601 or `YYYY-MM-DD HH:MM:SS` UTC) and
`pinned_first=0` (pinned pastes stay in sort order), which is how OpenVibe.Live's Content and
Moments feeds read it.

- **People are Network subjects** (`usr_…`, `gst_…`), never service-local integers. A browser's
  owner is the JWT's `subject_id` (older tokens are resolved once through the Network and
  cached in `legacy_id_map`). In responses `user_id` carries that subject id, next to
  `owner_subject` and `origin`; names/avatars come from `subject_projection`, a cache
  refreshed through the Network's `POST /internal/identity/resolve-batch` (service token,
  `identity.subject.resolve`).
- **Service callers** (Live's adapter, Live's AI jobs) send a Network service token for
  audience `openvibe.community` and need the route's capability: `community.paste.create`
  (create), `community.paste.write` (edit, delete, fork, like, copy, comment as someone),
  `community.paste.moderate` (`/admin/*`, `/bulk`, `/:slug/censor`, the AI queue
  `?needs_ai=1` and `POST /:slug/ai`). Headers: `X-OV-Subject: usr_…|gst_…` names the acting
  person (no subject = anonymous); `X-OV-Origin: ai` stores AI output with origin `ai` and no
  owner; `X-OV-Source-Ref: <EntityRef JSON>` records e.g. the stream; `X-OV-Staff: 1` (needs
  moderate) vouches that the acting person is staff. Services may bring a `slug` and
  `metadata`; browsers never. Identity is never read from bodies or queries.
- **Limits** as before: 20 anonymous writes per 10 minutes per address (API and the no-JS
  form share it); people get Media's 30 s paste cooldown, 200/day and comment limits.
- **Screenshots**: new uploads lose their EXIF/XMP metadata and go to Media's file store
  (`POST ${OV_MEDIA_INTERNAL_URL}/api/v1/community/files`, service token with
  `media.object.upload`); the paste keeps the public URL and `media_ref`
  `legacy:community:file:<key>`. Imported pastes keep their existing Media screenshot URLs.
- **Slugs**: public pastes get a short `adj-noun-NN` slug; a new unlisted or private paste (and
  a fork of one) gets `adj-noun-` + 16 random base62 characters, because its slug is the only
  thing keeping it unlisted. Existing slugs never change and keep working.
- **Deletes are soft** (content scrubbed, slug kept reserved); edits append `paste_versions`.

Moving the data: `node scripts/import-pastes.js <bundle.json> [--dry-run] [--id-fix-cutoff
2026-08-20T03:00:26Z]` imports Media's `openvibe.media.pastes-export` bundle. It checks the
bundle's format, counts and sha256 first, is idempotent (upsert by `legacy_media_id`; a newer
bundle adds and updates, counters never go down, local edits and deletes stay), maps Live user
ids to subjects through the Network (rows before the cutoff are also checked as Network ids;
disagreement or no answer imports the row ownerless and records an `import_hold`), keeps AI
moment pastes ownerless with origin `ai`, and prints a reconciliation report (also stored in
`migration_runs`). `--dry-run` rolls everything back.

`/by-user/:username` and `?username=` look the name up in `subject_projection` (the Network
has no service-token lookup by username), so a person appears there once Community has seen
them — signed in here, or named as an author in a resolved projection.

## Endpoints

Pages (server-rendered HTML):

| Route | What |
| --- | --- |
| `GET /` | Home: hero, latest pastes, most viewed, "start a paste" CTA, what is coming |
| `GET /pastes` | Browse — `?q=` search, `?sort=new\|views`, `?lang=`, `?page=` |
| `GET /p/:slug` | Paste page — highlighted body (server-side, highlight.js), raw/download/copy/fork/share, screenshot, related |
| `GET /p/:slug/raw` | `live`: 302 → `https://openvibe.media/p/:slug/raw`; `community`: the text itself |
| `GET /p/:slug/screenshot` | `live`: 302 → Media's `/p/:slug/screenshot`; `community`: 302 → the stored image URL |
| `GET /p/:slug/download` | The text as an attachment (`slug.ext`); screenshots bounce to the image |
| `GET /new`, `POST /new` | Create (signed-in or anonymous). `?fork=slug` prefills. The POST is the no-JS fallback; with JS the form talks to `/api/pastes` |
| `GET /my` | The signed-in user's pastes (public, unlisted and private); anonymous → sign-in |
| `GET /s` | Spaces |
| `GET /s/:space` | Threads — `?sort=hot\|new\|top`, `?page=` |
| `GET /s/:space/t/:slug` | A thread with its posts (`?page=`), reply / vote / moderation forms |
| `GET /s/:space/new`, `POST /s/:space/new` | Start a thread (signed in) |
| `POST /s/:space/t/:slug/reply\|vote\|state\|delete` | The no-JS forms (reply, vote, pin/lock, delete) |
| `GET /pulse` | Public activity across the network — `?origin=user\|ai\|system`, `?after=` |
| `GET /c/:accessId`, `POST /c/:accessId` | One comment thread's own page — the same thread the owner product embeds (e.g. a Live VOD), newest first, `?after=` for older; signed-in people comment with the no-JS form. Opens only by the unguessable access id, `noindex` |

API and machine endpoints:

| Route | What |
| --- | --- |
| `ANY /api/pastes/*` | `live`: transparent proxy to Live `/api/pastes/*` — list, get, create, `screenshot` (multipart), `:slug/copy`, `:slug/like`, comments, delete… bodies stream through untouched. `community`: the native API (same surface, plus `/:slug/versions`) |
| `/api/v1/comments/*` | Typed comment threads — see [Comments API](#comments-api) |
| `/api/v1/spaces/*`, `/api/v1/posts/*` | The forum — see [Forum](#forum-spaces-threads-posts) |
| `/api/v1/pulse/*` | Pulse — see [Pulse](#pulse) |
| `/api/v1/relay/*` | Discord relay administration (staff) — see [Discord relay](#discord-relay) |
| `GET /api/health`, `GET /api/ready` | Liveness / readiness (see below) |
| `GET /metrics` | Prometheus text for direct loopback callers only (404 through nginx) |
| `GET /release.json`, `POST /release-metrics` | What this server runs (ADR-016 release manifest, `metrics_url: /release-metrics`); open tabs' update reports (release-watch's same-origin beacon, no auth) |
| `GET /auth/login` | → Network `/oauth/authorize`. `?next=` (same-site path, this origin, or `https://openvibe.network/…`), `?silent=1` adds `prompt=none` |
| `GET /auth/callback` | Code exchange; sets cookies. `error=login_required` → `next` + `?sso=none` |
| `GET /auth/logout` | Clears session, sets `ov_sso_hint=guest`, honours `?next=` |
| `GET /auth/me` | Offline-verified profile from `ov_token` |
| `POST /auth/refresh` | Rotate via refresh token |
| `GET /robots.txt`, `GET /sitemap.xml`, `GET /feed.xml` | SEO + RSS of the latest pastes |
| `GET /s/feed.xml`, `GET /s/:space/feed.xml` | RSS of the latest threads (public spaces) |

**Readiness and metrics (Track O).** `GET /api/ready` (openvibe-shared/ready) answers 503 only
when the required `db` check fails (a real query on Community's SQLite). `network_jwks` (the
Network signing key; without it nobody can sign in or write as a signed-in viewer or service),
`live` (in `PASTES_AUTHORITY=live`: paste pages and `/api/pastes` read through Live) and `media`
(in `community` mode: screenshot and file uploads) are optional: a failure keeps the site ready
(comments, forum, Pulse and public reads still work) and is listed in `degraded` with
`status: "degraded"`. Every check reports `status`, `required`, `latency_ms` and `checked_at`.
Until Track O this route returned `{ "ready": true }` unconditionally. `GET /metrics` serves HTTP
golden signals by route template (`http_requests_total{method,route,status_class}`,
`http_request_duration_seconds`, `http_requests_in_flight`), process metrics and
`release_info`, and `release_client_updates_total{outcome,reason}` from the tabs' reports to
`POST /release-metrics` (openvibe-shared `release.mount`); content counts (pastes, comments,
threads) are deliberately not metrics.

Cookies are host-only for `openvibe.community`: `ov_token` (24 h access JWT, JS-readable so
the shared navbar can use it), `ov_refresh` (httpOnly, `/auth`), `ov_sso_hint`
(`account`/`guest`, 1 year, JS-readable — the navbar only tries a silent sign-in when it says
`account`).

## Comments API

`/api/v1/comments` is the comment system every OpenVibe product embeds instead of owning
comment tables. A thread belongs to one entity, named by an EntityRef
(`common.entity-ref@1`: `{ service, type, id, label? }`), and is created the first time anyone
resolves it. Errors are `application/problem+json` (`errors.problem@1`, with the legacy
`error` field).

| Route | What |
| --- | --- |
| `POST /threads/resolve` `{ ref }` | Get-or-create the entity's thread (201 created, 200 existing; idempotent, unique on service+type+id) |
| `GET /threads/:id` | The thread + first page of top-level comments, replies nested one level. `?after=<last id>`, `?sort=old\|new`, `?limit=`; `?parent=<id>` pages one comment's replies |
| `POST /threads/:id/comments` `{ message, parent_id?, anon_name? }` | Comment. A reply to a reply joins the top-level comment's replies |
| `GET /:commentId` | Services only: one comment and its thread (with the ref) — an owner product checks what a comment belongs to before it edits or deletes it for someone. Browsers get 404 (comment ids are sequential) |
| `PATCH /:commentId` `{ message }` | The author only; sets `edited_at` |
| `DELETE /:commentId` | The author or a moderator (soft; a top-level comment with replies stays as a tombstone) |
| `POST /:commentId/votes` `{ value: 1\|-1\|0 }` | Add, change or remove your vote (people only) |
| `PUT /threads/:id/visibility` `{ visibility: public\|hidden\|locked }` | Moderators — e.g. the owner service hides the thread of an entity it took down |

Who may do what:

- **Browsers** (the Network JWT as `ov_token` cookie here, or `Authorization: Bearer` from
  another OpenVibe site through CORS — `API_CORS_ORIGINS`, never cookies) resolve threads only
  for these types: `live` stream, channel · `media` object · `community` paste, post
  · `wiki` page · `blog` post · `reviews` entity. Community's own refs must exist and be
  visible. Labels are only taken from services. Live VODs and clips are resolved by Live only:
  a private one is missing to everyone but its owners and staff, which only Live can decide, so
  Live hands the access id only to people who may see the item.
- **Signed-in only**: threads of `live` vod and clip take no anonymous comments (Live's rule) —
  a browser without a subject, or a service naming nobody, gets 401 `auth.required`.
- **Anonymous** visitors comment with an `anon_name`, under the same 20-writes-per-10-minutes
  budget per address as anonymous pastes. People are limited per subject (10 s cooldown,
  5 per minute, no duplicate in a row; 60 votes a minute), whichever way they write.
- **Services** (Network service token, audience `openvibe.community`): `community.comment.write`
  resolves any ref and comments/votes/deletes as `X-OV-Subject`, or as AI with
  `X-OV-Origin: ai` (stored with origin `ai` and no author, shown as "OpenVibe AI").
  `community.comment.moderate` moderates — as itself (no `X-OV-Subject`), or for a person it
  vouches is staff with `X-OV-Staff: 1`.
- **Thread ids**: every thread has an unguessable access id (`cth_` + 22 characters). Browsers
  get it as the thread's `id` (from resolve) and can address a thread only by it; the sequential
  id works for services only (their resolve answer carries it as `id`, plus `access_id` to hand to
  a browser). Nobody can walk thread ids to find the refs and comments of entities they were not
  given.
- **Locked** threads can be read but take no comments or votes (moderators still may);
  **hidden** threads are 404 for everyone but moderators.
- Paste comments stay in `paste_comments` behind `/api/pastes/:slug/comments` for now.
- Comments carry `edited_at` (null until the author edits) and `can_edit` / `can_delete` for the
  viewer.

### Live's VOD and clip comments

Since roadmap Wave 5 (exit criterion: Live and a second product share one Community thread),
OpenVibe.Live keeps no comments of its own: its `/api/comments/:type/:id` routes are an adapter
over the thread of `{ service: 'live', type: 'vod'|'clip', id }` (Live's
`server/comments-client.js`). Live resolves the thread with its service token after its own
visibility check, reads and comments as the signed-in person (`X-OV-Subject`), edits as the
author, and deletes as the author, as staff (`X-OV-Staff: 1`) or — for the VOD's or clip's
owner — as itself (`community.comment.moderate`). Deleting a VOD or clip hides its thread. The
same thread is this site's page `/c/<access id>`; Live links to it under a public or unlisted
item's comments.

**Checking that both show the same thread** (production or local):

1. Open a public VOD on Live (`https://openvibe.live/vod/<id>`), post a comment, and follow
   "View this thread on OpenVibe.Community" under the comments. The page `/c/cth_…` lists the
   same comments, newest first, with the same authors.
2. Comment on that Community page while signed in, reload the Live VOD: the new comment is
   there. Delete it on Live: it is gone from the Community page.
3. Service-side, the same answer: `GET /api/v1/comments/threads/<id>?sort=new` with Live's token
   returns the comments both pages render (`test/comments.test.js` checks the page against it).

**Moving Live's old rows** (`scripts/import-live-comments.js`, `server/comments/live-import.js`):
reads Live's `comments` table read-only, puts every row in exactly one bucket and prints the
reconciliation `read = imported + held + excluded`. Imported rows keep their text and times
(edits keep `edited_at`); the ledger is `legacy_id_map` (`live`/`comment`/<live id> → comment
id), so re-running imports nothing twice. Authors become Network subjects from Live's
`linked_accounts.subject_id` and the Network's identity map (system `live`); a row whose author
maps nowhere (`unmapped_author`), maps two ways (`ambiguous_author`) or whose parent is held
(`parent_held`) is **held** in `import_hold` (source type `live_comment`) and listed, and a later
run imports it once the mapping exists. Deleted rows and replies under them, orphans and empty
messages are **excluded**. Dry run is the default (everything rolled back); `--apply` requires
`--backup <new file>`, an online backup of Community's database that is integrity-checked
before anything is written. Community must be deployed first (the script refuses a database
without `comments.edited_at` rather than migrate it from a dry run).

Production (on the host, as the service's own user and environment through `systemd-run`, so
no file in `/var/lib/openvibe-community` ends up owned by root). Order: deploy Community → dry
run → apply → deploy Live → apply again (catches comments Live wrote in between; the ledger
skips the rest) → verify as above.

```
RUN="sudo systemd-run --wait --pipe --collect -p User=ubuntu -p Group=ubuntu \
  -p WorkingDirectory=/opt/openvibe.community -p EnvironmentFile=/etc/openvibe/community.env \
  -E NODE_ENV=production -E COMMUNITY_DB_PATH=/var/lib/openvibe-community/community.db"
ARGS="--live-db /opt/openvibe.live/data/live.db --community-db /var/lib/openvibe-community/community.db"

$RUN /usr/bin/env node scripts/import-live-comments.js $ARGS                      # dry run
$RUN /usr/bin/env node scripts/import-live-comments.js $ARGS --apply \
  --backup /var/lib/openvibe-community/community.pre-live-comments-$(date -u +%Y%m%dT%H%M%SZ).db
```

Held rows: `sqlite3 /var/lib/openvibe-community/community.db "SELECT * FROM import_hold WHERE
source_type = 'live_comment'"`. Rollback: stop Community, copy the backup over `community.db`
(remove `community.db-wal`/`-shm`), start it; Live's own rows were never changed.

Embedding it — server-side, from another product's backend (the usual way; the person is the
one your own session says it is):

```js
const COMMUNITY = 'http://127.0.0.1:4200/api/v1/comments';
const token = await tokens.authHeaders();          // openvibe-contracts serviceAuth token client,
                                                   // audience openvibe.community, community.comment.write
const ref = { service: 'live', type: 'vod', id: String(vod.id), label: vod.title };
const { thread } = await (await fetch(`${COMMUNITY}/threads/resolve`, {
    method: 'POST', headers: { ...token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }),
})).json();
const page = await (await fetch(`${COMMUNITY}/threads/${thread.id}`, { headers: token })).json();
// page.comments[i] = { id, author: { subject, username, display_name, avatar_url } | null, anon_name,
//                      display_name, origin, message, score, my_vote, reply_count, replies: [...], ... }
await fetch(`${COMMUNITY}/threads/${thread.id}/comments`, {
    method: 'POST',
    headers: { ...token, 'X-OV-Subject': viewer.subjectId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Great VOD!' }),
});
```

In the browser, from a page on an allowed origin that holds the visitor's Network JWT:

```js
const api = (path, opts = {}) => fetch(`https://openvibe.community/api/v1/comments${path}`, {
    ...opts, headers: { Authorization: `Bearer ${networkJwt}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
}).then((r) => r.json());
const { thread } = await api('/threads/resolve', { method: 'POST', body: JSON.stringify({ ref: { service: 'live', type: 'stream', id: streamId } }) });
let { comments, next_cursor } = await api(`/threads/${thread.id}`);
if (next_cursor) ({ comments } = await api(`/threads/${thread.id}?after=${next_cursor}`));
await api(`/${comments[0].id}/votes`, { method: 'POST', body: JSON.stringify({ value: 1 }) });
```

Render `message` as text (it is plain text, never HTML).

## Forum: spaces, threads, posts

Spaces hold threads; a thread is its opening post plus replies (Markdown). Seeded spaces:
`general`, `feedback` (feature requests), `showcase`. Space visibility: `public` (anyone
reads, people post), `members` (signed-in people only; every Network account counts as a
member for now), `staff` (moderators only; looks missing to everyone else).

- **Pages work without JavaScript** — sorting and pagination are links, replying, voting,
  pin/lock and delete are plain form posts (SameSite=Lax cookie; a foreign `Origin` is
  refused). Thread pages carry canonical, Open Graph `article`, `DiscussionForumPosting`
  JSON-LD (author, dates, counters, the replies on the page as `Comment`s) and breadcrumbs;
  members/staff spaces are `noindex,nofollow` and never in the sitemap or feeds. The sitemap
  lists `/s`, `/pulse`, public spaces and the latest 1000 threads; `/s/*/new` is disallowed in
  robots.txt.
- **Sorting**: `hot` (default), `new`, `top`; pinned threads lead every sort. Hot is the
  deterministic `ov_hot(score, age_hours) = (score + 1) / (age_hours + 2) ^ 1.5`
  (`server/db.js`), computed against one `now` per page.
- **Markdown** (`server/render/markdown.js`) is a safe subset: everything is escaped first and
  only fixed tags are written — paragraphs, line breaks, headings (demoted to h3–h6), quotes,
  lists, `---`, fenced code (highlighted like pastes), inline code, bold/italic/strike, links
  (http(s), mailto, same-site paths, fragments; `rel="nofollow ugc noopener"`). Raw HTML is
  shown as text.
- **Writers**: people (browser JWT, or a service with `community.post.create` naming them in
  `X-OV-Subject`) and AI output (`X-OV-Origin: ai` — no author, labelled as AI). Anonymous
  visitors read. Limits per person: a thread every 30 s, 3 a minute, 20 a day; a post every
  10 s, 6 a minute, no duplicate in a row. Edits keep every revision in `post_versions`;
  deletes are soft (tombstones keep the numbering; deleting the opening post deletes the
  thread). Moderators (admin/global_mod browsers; services with `community.comment.moderate`)
  pin, lock and delete; locked threads take no replies or votes.

- **Two styles, one system.** Each space is a **forum** or a **feed**. A forum reads like vBulletin or SMF:
  - the board index at `/s` lists every space under its group, with topics, posts and the last post;
  - a board is a topic table (Replies, Views, Last post) with sticky topics first and replies bumping a topic;
  - a topic shows each post beside its author's panel: picture, posts, since when, the ratings they get most.
  Quote fills the reply box. A feed is subreddit-like: votes and hot/new/top. Moderators switch per space:
  the style, up/down votes and ratings. They also set the group, a parent (one level of child boards),
  the name and description, and create spaces (`/s/new-space`).
  Both styles share threads, ratings, images, pastes and crossposts: a thread can be crossposted to another
  space, and both link to each other.
- **Ratings** (after Facepunch), one per person per post, never your own:
  - positive: Agree ✅, Winner 🏆, Funny 😂, Informative 💡, Friendly 😊, Sympathy ❤️;
  - negative: Dumb 📦, Disgusting 🤢;
  - utility: Bad reading 📖, Late 🕒.
  The same rating again takes it back, and another replaces it. Hovering shows who gave it.
- **Pastes on posts.** Up to 4 public or unlisted pastes per post, shown as cards with their first lines or
  the screenshot. A paste made private or deleted drops out. Every paste page has "Discuss in a space".
- **Categories, requests and the roadmap.** A space's `thread_kind` decides what a new thread is. In a
  `discussion` space it is a plain thread. In `request` (Feedback, with Ideas, Bugs and Questions
  categories) it is open to votes and starts `open`; staff move it through its statuses. In `roadmap`
  only staff start items. The Roadmap space follows [`docs/roadmap/public.json`](docs/roadmap/public.json):
  every boot syncs it (`server/forum/roadmap.js`), one thread per item, matched by key. A changed summary
  is an edit of the item's opening post, so the history stays, and replies and votes stay with the item.

- **Images on posts.** Up to 4 per thread or reply: PNG, JPEG, GIF or WebP by content, 8 MB each, with
  metadata stripped. Each is stored in OpenVibe.Media's Object API as a public `med_` object owned by the
  person (tenant `community`, Community's service token; `server/media/objects.js`). `attachments` holds
  the reference until the post naming it is saved. The no-JS forms upload and attach in one step.

API (`/api/v1/spaces`, `/api/v1/posts`, problem+json errors):

| Route | What |
| --- | --- |
| `GET /spaces` · `GET /spaces/:space` | Spaces the caller can open · one space |
| `GET /spaces/:space/threads?sort=&page=&limit=&category=&status=` | Threads (server pagination: `page`, `pages`, `total`), the space's `categories`, optionally one category or status |
| `POST /spaces/:space/threads` `{ title, body, category?, members_only? }` | New thread (`community.post.create` for services); `members_only: true` gates it to the author's VIP members |
| `POST /spaces/:space/attachments` (multipart `file`) | An image for a new thread or reply → `{ attachment: { media_id, url, … } }`; name it in `attachments: [media_id]` when posting |
| `GET /spaces/:space/categories` · `PUT`/`DELETE /spaces/:space/categories/:category` `{ name, description?, position? }` | Categories · moderators manage them (a deleted category's threads stay, uncategorised) |
| `POST /spaces` · `PUT /spaces/:space/settings` `{ style, votes, reactions, group, parent, name, description, kind }` | Moderators: new space · settings. `GET/PUT /api/v1/space-groups[/:group]` manages the board index's groups |
| `POST /spaces/:space/threads/:slug/crosspost` `{ to }` | Crosspost to another space |
| `POST /posts/:id/reactions` `{ reaction \| null }` | Rate a post |
| `PUT /spaces/:space/threads/:slug/category` `{ category: slug \| null }` | The author or moderators |
| `PUT /spaces/:space/threads/:slug/status` `{ status }` | Moderators: requests `open`/`planned`/`in_progress`/`done`/`declined`, roadmap items `planned`/`in_progress`/`done`/`paused` |
| `GET /spaces/:space/threads/:slug?page=` | Thread + posts (`body_markdown` and rendered `body_html`) |
| `DELETE /spaces/:space/threads/:slug` | Author or moderator |
| `POST /spaces/:space/threads/:slug/posts` `{ body }` | Reply |
| `POST /spaces/:space/threads/:slug/votes` `{ value: 1\|-1\|0 }` | Vote |
| `PUT /spaces/:space/threads/:slug/state` `{ pinned?, locked? }` | Moderators |
| `PUT /spaces/:space/members-only` `{ owner: 'usr_…' \| null }` | Moderators: gate a space to a creator's VIP members (or open it) |
| `PUT /spaces/:space/threads/:slug/members-only` `{ owner: 'usr_…' \| true \| null }` | The author (to their own members) or moderators (any creator) |
| `PUT /posts/:id` `{ body }` · `DELETE /posts/:id` · `GET /posts/:id/versions` | Author or moderator |

### Members-only spaces and threads (OpenVibe.VIP)

A space or a single thread can be for one creator's [OpenVibe.VIP](https://github.com/OpenVibers/OpenVibe.VIP)
members: `members_only_owner` holds the creator's Network subject (`usr_…`). Moderators gate spaces
(for any creator) and threads; a thread's author gates it to their own members (and opens it again),
by the API, the `members_only` box on the new-thread form, or the button on the thread page.

- **Reading and posting need an active entitlement**: listing a gated space's threads, reading a
  thread, starting a thread, replying, voting, editing and post history. Community asks VIP
  `POST /api/v1/policies/evaluate` `{ subject, resource: { service: 'community', type: 'space'|'thread', id },
  owner, fallback: { requirement: 'member', binding: 'community:members_only' } }` — the owner is the
  one Community stored, and the creator's own VIP rule for that resource (plan or perk requirement) wins
  over the default gate. A gated thread in a gated space needs both.
- **The owner and discussion moderators always pass** (the owner without asking VIP).
- **Fails closed**: signed out, not a member, VIP down, a refused token or no `OV_OAUTH_CLIENT_SECRET`
  are all `403 vip.members_only` `{ reason, gate, members_only: { owner, owner_username, join_url } }`.
  Pages show a `noindex` teaser (space name, or the thread title) with the join link to the creator's
  page on openvibe.vip, never a post.
- **Listings** keep a gated thread's title with `members_only` (never a body); gated spaces are listed
  with their join link.
- **Never public**: gated spaces and threads stay out of Pulse (not recorded, removed when gated later,
  and filtered at read time), the Discord relay (not queued; pending deliveries dropped; re-checked at
  send), the sitemap, the RSS feeds (a gated space's feed is 404) and JSON-LD; a member's view of a
  gated thread is `noindex` as well.
- **Convergence**: answers are cached per viewer and resource (`server/vip/`, VIP's `createVipCache`):
  a "yes" at most `VIP_CACHE_TTL_MS` (30 s), a "no" 10 s, a failure 2 s. Community has no Events inbox,
  so **once VIP stops granting** (it applied Billing's `billing.entitlement.changed` and emitted
  `vip.membership.changed`) **Community stops within 30 s**; the end-to-end bound from Billing's change
  is VIP's (seconds with events, at most `VIP_PROJECTION_MAX_AGE_MS` + 30 s without; see the table in
  OpenVibe.VIP's README). `app.locals.vip.cache.handleEvent(envelope)` converges at once if an Events
  subscription is added later. `test/members-only.test.js` proves both.
- The client (`server/vip/vip-client.js`) is OpenVibe.VIP's `client/vip-client.js` vendored at 2accbeb
  until VIP publishes a tag to pin.
- **Grant needed** on the Network: `community` → `vip.resource.policy.evaluate` on `openvibe.vip`.

Votes (comments and threads) are one UPSERT per person plus a score recomputed from the vote
rows in the same IMMEDIATE transaction (`server/votes.js`), so concurrent votes cannot drift
a score.

## Discord relay

Outbound only, and off unless `DISCORD_RELAY_ENABLED=true`. When a thread is created in a
public space that has an enabled mapping, Community posts "New thread in s/<space> by <name>"
with the title, an excerpt and a link to the thread to that mapping's Discord webhook.

- A mapping (`relay_mappings`) names the **environment variable** that holds the webhook URL
  (`webhook_url_ref`, e.g. `DISCORD_WEBHOOK_FEEDBACK`); the URL itself never enters the
  database or any API response. Put the variable in `/etc/openvibe/community.env`. Only
  allow-listed names can be mapped or sent to: `DISCORD_WEBHOOK_*`, or exactly the names in
  `DISCORD_RELAY_WEBHOOK_VARS` when that is set — staff cannot point the relay at the URL in any
  other variable (an internal service's base URL).
- One delivery per (thread, mapping) — the dedupe key in `relay_deliveries`. Network errors,
  timeouts, 5xx, 429 (its `retry_after` honoured) and an unset variable are retried with
  exponential backoff (`DISCORD_RELAY_BACKOFF_MS` · 2^(attempt−1), at most an hour) up to
  `DISCORD_RELAY_MAX_ATTEMPTS`; other 4xx fail at once. Mentions are disabled.
- Loop prevention: a thread whose origin is `discord` is never relayed out (checked when
  queueing and when sending). Members/staff spaces are never relayed.
- Staff (admin/global_mod browsers, or services with `community.comment.moderate`):
  `GET /api/v1/relay/deliveries?status=failed` shows what failed and why,
  `POST /api/v1/relay/deliveries/:id/retry` queues one again,
  `GET|POST /api/v1/relay/mappings` and `PUT /api/v1/relay/mappings/:id { enabled }` manage
  mappings (`POST { space: 'feedback', webhook_url_ref: 'DISCORD_WEBHOOK_FEEDBACK' }`).

## Pulse

A read model of public activity across the network, with provenance (`pulse_items`, unique
per source service/type/id).

- **Community's own**: new public pastes written by a person (not burn-after-read, not NSFW),
  new threads and replies in public spaces — recorded at write time, removed when deleted or
  made non-public, and re-checked against their source on every read, so private or unlisted
  things never show.
- **Other services** publish with `community.pulse.write`:
  `POST /api/v1/pulse/items { ref, title, url, origin?, occurred_at?, visibility? }` — the
  ref's `service` must be the caller's own (`svc:live` → `live`), `visibility` other than
  `public` is refused, `X-OV-Subject` names the person for origin `user`. Re-posting a source
  updates its title and link; origin, actor and time stay the first record's.
  `DELETE /api/v1/pulse/items/:service/:type/:id` retracts one.
- **Reading**: `GET /api/v1/pulse?origin=user|ai|system&after=<cursor>&limit=` (newest first,
  keyset cursor), and the `/pulse` page. AI items carry `label: 'AI'` and never an actor —
  they are never attributed to a person (roadmap §33); system items name no one either.

## Platform blocks

People block each other once, on OpenVibe.Network (roadmap WS-E task 5, Contracts 0.49.0), and Community
honours it (`server/identity/blocks.js`): nobody replies in a forum thread whose author blocked them, replies
to a comment whose author blocked them (or to a reply that joins that comment), or comments on a paste (paste
API or comment thread) or forum post whose owner blocked them. The API answers 403 `community.blocked` (a
problem under `/api/v1`, `{ error, code }` under `/api/pastes`); the no-JS forms show the message with the
draft kept. Anonymous comments carry no subject and so are not affected; moderation never is.

The blocks come from `network.block.changed` (POST `/internal/events`, `server/pulse/consumer.js`) into the
`network_blocks` projection, newest revision per pair. Boot creates the missing subscription
(`startSubscriptions`, `COMMUNITY_EVENTS_SECRET`, `EVENTS_URL`); a new subscription gets no history, so
blocks made before it existed need a replay from OpenVibe.Events.

## Capabilities

Community checks service tokens against these capabilities (manifests in
`docs/capabilities-proposal/`, same shape as OpenVibe.Contracts' `manifests/capabilities`):

| Id | Status | Used for |
| --- | --- | --- |
| `community.paste.create` / `.write` / `.moderate` | active in contracts | pastes |
| `community.comment.write` | active in contracts (v0.7.0) | comment threads as a person or AI |
| `community.comment.moderate` | active in contracts (v0.7.0) | thread visibility, comment/post/thread moderation, relay admin |
| `community.pulse.write` | active in contracts (v0.7.0) | publishing to Pulse |
| `community.post.create` | active in contracts (v0.7.0) | forum writes |

This repository pins `openvibe-contracts` v0.49.0, which knows every id above, so they all go
through the library's `capabilities.check`. `server/identity/capabilities.js` still decides an id
the installed contracts do not know locally, with the library's own matching rule (the exact id
or a `prefix.*` grant).

## SEO

Every page carries a title, description, canonical, robots, Open Graph + Twitter card and
JSON-LD (`WebSite` on the home page, `Article`/`ImageObject` with author and `datePublished`
on paste pages, `DiscussionForumPosting` on threads, `BreadcrumbList` everywhere).
Unlisted/private pastes, search result pages and members/staff spaces are `noindex`. The
sitemap lists home, `/pastes`, the latest public pastes, `/s`, `/pulse`, public spaces and
their latest threads (cached 1 h).

## Configuration

Copy `.env.example` to `.env` (production: `/etc/openvibe/community.env`, mode 0600).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `4200` / `127.0.0.1` | Listen address (nginx in front) |
| `BASE_URL` | `https://openvibe.community` in production | Canonical origin |
| `TRUST_PROXY` | `2` | X-Forwarded-For hops (Cloudflare → nginx → Node) |
| `OV_NETWORK_URL` | `https://openvibe.network` | Issuer / authorize URL / JWKS |
| `OV_NETWORK_INTERNAL_URL` | `http://127.0.0.1:4000` | Token grants, JWKS (tried first) |
| `OV_OAUTH_CLIENT_ID` | `community` | Registered on the Network |
| `OV_OAUTH_CLIENT_SECRET` | — | **Required** for sign-in |
| `OV_OAUTH_REDIRECT_URI` | `https://openvibe.community/auth/callback` | Must match the registration |
| `OV_LIVE_INTERNAL_URL` | `http://127.0.0.1:3000` | Live's `/api/pastes` |
| `OV_LIVE_URL` | `https://openvibe.live` | Author links, avatars, legal pages |
| `OV_MEDIA_URL` | `https://openvibe.media` | Raw text + screenshots |
| `OV_MEDIA_INTERNAL_URL` | `http://127.0.0.1:4100` | Media file store for new screenshots (`community` authority) |
| `PASTES_AUTHORITY` | `live` | `live` = proxy to Live; `community` = this site's database is the authority |
| `COMMUNITY_DB_PATH` | `./data/community.db` | SQLite file (the systemd unit sets `/var/lib/openvibe-community/community.db`) |
| `API_CORS_ORIGINS` | Live, Media, Network, Tools, Games origins | Browser origins that may call `/api/v1/comments` and `/api/v1/pulse` with a Bearer JWT |
| `DISCORD_RELAY_ENABLED` | off | `true` turns the outbound Discord relay on |
| `DISCORD_RELAY_POLL_MS` / `DISCORD_RELAY_BACKOFF_MS` / `DISCORD_RELAY_MAX_ATTEMPTS` | `30000` / `30000` / `6` | Relay worker cadence, first retry delay, attempts before `failed` |
| *(any name)* e.g. `DISCORD_WEBHOOK_FEEDBACK` | — | A Discord webhook URL, named by a relay mapping's `webhook_url_ref` |
| `VIEW_HASH_SECRET` | derived from the client secret | Salt for hashed visitor ids in view counts |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-http local dev |
| `OV_VIP_INTERNAL_URL` | `http://127.0.0.1:4620` | OpenVibe.VIP's API (members-only spaces and threads) |
| `OV_VIP_URL` | `https://openvibe.vip` | Public VIP site, for join links |
| `VIP_TIMEOUT_MS` | `2000` | One VIP call |
| `VIP_CACHE_TTL_MS` / `VIP_CACHE_DENY_TTL_MS` / `VIP_CACHE_UNAVAILABLE_TTL_MS` | `30000` / `10000` / `2000` | How long a yes / no / failure is cached (the yes TTL is the convergence bound) |

## Run

```
npm install
npm start          # http://127.0.0.1:4200
npm test           # mocks Live, Network and Media in-process; no network needed
```

## Deploy

```
/opt/openvibe.community                     # git checkout, `npm ci --omit=dev`
/etc/openvibe/community.env                 # secrets (0600)
deploy/systemd/openvibe-community.service   # → /etc/systemd/system/, User=openvibe, port 4200
deploy/nginx/openvibe.community.conf        # → /etc/nginx/sites-available/, TLS from
                                            #   /etc/letsencrypt/live/openvibe.community/
```

Update: `git pull && npm ci --omit=dev && systemctl restart openvibe-community`. The schema
is created idempotently at boot in every mode (comments, the forum, Pulse and the relay live
in Community's database whichever service owns pastes; the three seed spaces are inserted
once). The database lives in the unit's `StateDirectory` (`/var/lib/openvibe-community`), so
the code tree stays read-only.

Flipping to `community` (done in production on 2026-09-22) needed the Network's `community` OAuth client to have the
`identity.subject.resolve` capability (audience `openvibe.network`) and
`media.object.upload` (audience `openvibe.media`), and Live's service client the
`community.paste.*` capabilities it uses.

The Network must have the OAuth client `community` registered with redirect
`https://openvibe.community/auth/callback`, and serve the current `openvibe-shared`
`navbar.js` (with `links`/`menu`/`silentLogin` support) for the top links and silent sign-in
to appear.

## Layout

```
server/
  index.js            process entry (listen, graceful stop)
  graceful.js         SIGTERM: stop timers and scans, drain HTTP (4 s), settle the relays, close the DB, exit 0 (5 s at most)
  app.js              Express app factory: middleware, routes
  config.js           env → config
  db.js               SQLite (better-sqlite3): schema, opened at COMMUNITY_DB_PATH
  auth/routes.js      OAuth2 client (login/callback/logout/me/refresh), optionalAuth
  identity/viewer.js  who is calling: browser JWT, service token (+ X-OV-* headers), anonymous
  identity/network.js Network resolve-batch client + subject_projection cache
  media/files.js      new screenshot bytes → Media's file store (service token)
  media/strip-metadata.js  EXIF/XMP/text chunks out of JPEG/PNG/WebP without re-encoding
  live-client.js      server-side reads of Live's /api/pastes for rendered pages ('live')
  pastes/proxy.js     /api/pastes/* → Live (streams bodies, forwards token + address) ('live')
  pastes/api.js       native /api/pastes/* ('community')
  pastes/service.js   paste rules: visibility, limits, burn-after-read, views, shapes
  pastes/store.js     pure SQL over pastes / versions / likes / comments / projections
  pastes/importer.js  Media export bundle → store (scripts/import-pastes.js is the CLI)
  pastes/source.js    where pages read pastes from (Live or the store)
  pastes/catalog.js   recent public pastes: trending, related, language filter
  comments/           typed comment threads: store (SQL), service (rules), api (/api/v1/comments),
                      routes (the /c/:accessId page), live-import (Live's old VOD/clip comments)
  forum/              spaces/threads/posts: store, service, api (/api/v1/spaces, /posts), routes (pages)
  vip/                OpenVibe.VIP gate for members-only spaces/threads (index.js) + the vendored client
  pulse/              Pulse read model: store, service (hooks + ingest), api (/api/v1/pulse)
  relay/              Discord relay: discord.js (queue, worker, backoff), api (/api/v1/relay)
  http/v1.js          /api/v1 helpers: problem errors, capability guards, cursors, CORS
  identity/capabilities.js  capability checks incl. the proposed ids; discussion staff/moderators
  identity/authors.js author display from subject_projection; the AI label
  votes.js            race-safe up/down votes (comments, threads)
  limits.js           per-person write limits
  render/layout.js    page shell: SEO head, shared chrome, hashed assets
  render/pages.js     home / browse / paste / new / my / error templates
  render/forum.js     spaces / threads / thread / new-thread / members-only teaser templates
  render/pulse.js     the /pulse page
  render/comments.js  a comment thread's own page
  render/markdown.js  the safe Markdown subset for posts
  render/highlight.js highlight.js wrapper, language list, download extensions
  seo.js              robots, sitemap, RSS, JSON-LD builders
public/               css/community.css, js/community.js, favicon.svg, og-default.png
(openvibe-shared is the pinned OpenVibe.Shared v1.5.1 release, installed by npm)
deploy/               systemd unit, nginx vhost
scripts/import-pastes.js  Media paste bundle importer
scripts/import-live-comments.js  Live's VOD/clip comments → Community threads (dry run by default)
test/                 run.js + *.test.js (mock Live, Network and Media with a real RS256 key)
docs/capabilities-proposal/  Wave 5 capability manifests (released in openvibe-contracts v0.7.0)
```

## What is next

Spaces per streamer, game and project (with membership), inbound Discord relay (threads from
Discord arrive with origin `discord` and are never relayed back), visibility changes for
comment threads arriving through Events, moving paste comments onto the typed comment
threads, and submissions (clips, art, ideas, reports for community review).

## Related services

- Identity/SSO: https://openvibe.network (OpenVibers/OpenVibe.Network)
- Streaming: https://openvibe.live (OpenVibers/OpenVibe.Live)
- Tools: https://openvibe.tools (OpenVibers/OpenVibe.Tools)
- Media: https://openvibe.media (OpenVibers/OpenVibe.Media)
- Games: https://openvibe.games (OpenVibers/OpenVibe.Games)
