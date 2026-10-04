# OpenVibe.Community

**https://openvibe.community — the people of OpenVibe.**

## Purpose

The community hub of the OpenVibe network: community-run, open source, free speech within
the rules. It is the home of **pastes** (code, text and screenshots with a link), the
**forum** (spaces, threads and posts), the **comment threads** every other OpenVibe product
embeds, **Pulse**, the network's public activity, and [**submissions**](#submissions) — clips, art,
ideas and reports people send in for community review.

It is a small Node/Express app (CommonJS, no framework, one PostgreSQL database) that
server-renders every page — crawlers and no-JS readers get the whole thing — and adds a
little progressive JavaScript for pagination, copy buttons and the upload path.

## Owns

- pastes (the only authority since 2026-09-22), their versions, likes and
  comments
- the typed comment threads every other product embeds, the forum (spaces, threads, posts, votes,
  categories), Pulse (the network's public activity), submissions and the Discord relay
- the `community.*` events, Search documents for public threads, and the `community.profile` user module
- one PostgreSQL database (`ov_community` on the host's data role, ADR-035; schema in [migrations/](migrations/);
  embedded PGlite in development), with Valkey for the per-actor limit counters

## Does not own

- identity and SSO (OpenVibe.Network), file bytes (OpenVibe.Media keeps screenshots and attachments),
  memberships (OpenVibe.VIP decides members-only spaces and threads), chat rooms (OpenVibe.Chat)
- the content of the products whose threads it hosts: a product stores only the thread id

## Depends on

- OpenVibe.Network (SSO, JWKS, service tokens, `identity.subject.resolve`, the `community.profile` module)
- OpenVibe.Media (screenshot and attachment uploads), OpenVibe.VIP (members-only gates), OpenVibe.Chat
  (a space's room), OpenVibe.Events (the outbox relay and the Pulse and account subscriptions)
- OpenVibe.Live only for old VOD/clip comment imports (it reads and writes no pastes here any more)
- `openvibe-contracts` v0.76.0, `openvibe-sdk` v0.21.0 (events outbox, per-actor limits),
  `openvibe-shared` v2.2.0, pinned by release tarball

## How it fits the network

Pastes moved to Community in roadmap Wave 5; since 2026-09-22 Community's own database is their only
authority (there is no switch any more — `live-client.js` and the `/api/pastes` proxy were deleted) —
see [Community as the paste authority](#community-as-the-paste-authority). The import brought
889 + 2 pastes, 60 comments and 48 likes; 5 rows (1 paste, 4 comments, `ambiguous_owner`) wait in
`import_hold`. Live and Tools forward paste writes here, and Media answers old paste URLs with a 301 to
this site. Comments, the forum and Pulse are deployed but hold almost nothing yet (10 wiki comment
threads, 0 forum threads), and the Discord relay is off. A restore drill passed on 2026-09-23.

| Concern | Where it lives | How Community reaches it |
| --- | --- | --- |
| Paste storage + API | **Community's PostgreSQL** (`pastes`, `server/pastes/*`) | own database |
| Screenshot / attachment bytes | **OpenVibe.Media** (`/api/v1/community/files`, objects v2) | service token (`media.object.upload`) |
| Identity / SSO | **OpenVibe.Network** (OAuth2 + RS256 JWKS) | OAuth client `community` |
| Raw text, screenshots | Community's own routes; bytes on Media's public host | served locally, or a 302 to the stored image |
| Shared chrome, themes | `https://openvibe.network/shared/*.js` | loaded in every page |
| VIP memberships (members-only spaces/threads) | **OpenVibe.VIP** (`POST /api/v1/policies/evaluate`) | `OV_VIP_INTERNAL_URL`, service token (audience `openvibe.vip`, `vip.resource.policy.evaluate`) |
| A space's chat room | **OpenVibe.Chat** (`POST/DELETE /api/chat/rooms/:room/attachments`) | `OV_CHAT_INTERNAL_URL`, the signed-in person's own Network token (no service grant) |

Community resolves the visitor itself: a Network JWT names the account by its `subject_id` (`usr_…`),
which is exactly what Community stores, so there is no second identity to map and no proxy. Creation,
listing, anonymous-post limits, ownership and author names all come from Community's own rules
(`server/pastes/service.js`).

### Community as the paste authority

Community is the only paste authority: `/api/pastes/*` is the native API
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

Moving the data: Media's `openvibe.media.pastes-export` bundle was imported once (Wave 5, 2026-09-22; the ledger is
`legacy_id_map`, the report `migration_runs`). The importer (`scripts/import-pastes.js`) was retired with the move to
PostgreSQL and is in git history.

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
| `POST /p/:slug/comments` | Comment on the paste (signed in; the no-JS form) — its typed comment thread, the one `/c/:accessId` and the APIs show |
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
| `GET /submissions`, `POST /submissions` | Accepted submissions — `?kind=clip\|art\|idea\|report`, `?mine=1` (your own, any status), `?after=`; signed-in people submit with the no-JS form |
| `GET /submissions/:slug` | One submission — accepted: anyone (canonical, Open Graph); pending, rejected, withdrawn: its author and moderators only (`noindex`), 404 for anyone else |
| `POST /submissions/:slug/withdraw\|review` | The no-JS forms: the author withdraws; a moderator accepts or rejects with a note |
| `GET /submissions/review` | The moderators' queue (pending, newest first) |
| `GET /c/:accessId`, `POST /c/:accessId` | One comment thread's own page — the same thread the owner product embeds (e.g. a Live VOD), newest first, `?after=` for older; signed-in people comment with the no-JS form. Opens only by the unguessable access id, `noindex` |

API and machine endpoints:

| Route | What |
| --- | --- |
| `ANY /api/pastes/*` | The native API — list, get, create, `screenshot` (multipart), `:slug/copy`, `:slug/like`, comments, delete and `/:slug/versions` |
| `/api/v1/comments/*` | Typed comment threads — see [Comments API](#comments-api) |
| `/api/v1/spaces/*`, `/api/v1/posts/*` | The forum — see [Forum](#forum-spaces-threads-posts) |
| `/api/v1/pulse/*` | Pulse — see [Pulse](#pulse) |
| `/api/v1/submissions/*` | Submissions — see [Submissions](#submissions) |
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
| `GET /llms.txt`, `GET /llms-full.txt` | The site map for language models, and the latest public threads and text pastes in full |
| `GET /s/feed.xml`, `GET /s/:space/feed.xml` | RSS of the latest threads (public spaces) |

**Readiness and metrics (Track O).** `GET /api/ready` (openvibe-shared/ready) answers 503 only
when the required `db` check fails (a real round trip that names the store, postgresql or pglite, and a migrated schema). `network_jwks` (the
Network signing key; without it nobody can sign in or write as a signed-in viewer or service),
`media` (screenshot and file uploads) is optional: a failure keeps the site ready
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
- **Paste comments** are the paste's typed thread (`community`/`paste`/`<slug>`): the paste page
  (`/p/:slug` shows it newest first, `?sort=old` and `?after=<last comment id>` as links, `#comment-<id>`
  anchors; `POST /p/:slug/comments`, signed in, the no-JS form; none on burn-after-read pastes), `/api/pastes/:slug/comments` (GET, POST and
  DELETE keep their old shapes and rules: anonymous comments with a name, the author, the paste's
  owner or staff delete; Live's adapter calls them as the person) and `/api/v1/comments` all read and
  write that one thread. A paste thread follows the paste: private ones are their owner's and staff's
  only, deleted and burned ones nobody's (404 on every call, by access id too, so a paste made private
  later takes its comments with it); unlisted ones are open to whoever has the link. Migration
  `0004_paste_comments_to_threads.sql` copied the old `paste_comments` rows onto the threads (ledger
  `legacy_id_map`, `community`/`paste_comment` → `comment`); nothing writes `paste_comments` any more and
  it stays, read-only, for one release.
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

**Moving Live's old rows**: Live's VOD and clip comments were imported once (ledger `legacy_id_map`, `live`/`comment`;
held rows in `import_hold`, source type `live_comment`). The importer (`scripts/import-live-comments.js`,
`server/comments/live-import.js`) was retired with the move to PostgreSQL and is in git history, as is the
screenshot-reference migration (`scripts/migrate-screenshot-refs.js`, applied 2026-09-25: no paste keeps a legacy media reference).

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
- **A space's own moderators** (`space_moderators`, migration 0005): people listed for one space act there as
  moderators do everywhere: thread state, status and category, edits and deletes, replies in locked
  threads, the VIP gate (they pass it), members-only, settings (name, description, style, votes, ratings,
  kind), categories and the chat room. They cannot move the space on the board index (group, parent,
  position), create spaces, manage the board index's groups, add roadmap items or open staff spaces. Those
  stay with staff. Any moderator of a space, or staff, adds and removes that space's moderators. They must
  be Network users (`usr_…`), and nobody is added across a block in either direction. A listing counts only
  for the person signed in themselves, never for a service naming them. Account deletion erases the rows and
  a subject merge moves them. No capability or Contracts change is involved. The cutover runbook is
  `docs/cutover-community-0005-space-moderators.md`.

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
| `PUT /spaces/:space/chat-room` `{ room: slug \| https://openvibe.chat/r/<slug> }` | The space's owner or staff, signed in themselves: attach a chat room (201; the same room again 200) |
| `DELETE /spaces/:space/chat-room` | The space's owner or staff (moderator services too): detach it (idempotent) |
| `PUT /posts/:id` `{ body }` · `DELETE /posts/:id` · `GET /posts/:id/versions` | Author or moderator |
| `GET /spaces/:space/moderators` | The space's own moderators `{ space, moderators: [{ subject, username, display_name, added_by, added_at }] }` (whoever can read the space) |
| `PUT`/`DELETE /spaces/:space/moderators/:subject` | The space's moderators or staff: add (blocks refuse, 403 `community.blocked`) or remove one (idempotent). The no-JS forms are `POST /s/:space/moderators` and `POST /s/:space/moderators/remove` `{ subject }` |

### A space's chat room (OpenVibe.Chat)

A space can have one chat room on [OpenVibe.Chat](https://github.com/OpenVibers/OpenVibe.Chat) (roadmap WS-I
task 4, `server/chat-rooms.js`). Its owner (the space's creator, or the creator whose members' space it is)
or discussion staff attach one by its address or link, from the space page (no JavaScript) or
`PUT /api/v1/spaces/:space/chat-room`; the space page (feed and forum style) then links it, with its kind
(chat, call, announcements) and "members only" for a private room. Each side checks its own end:
Community checks the space; Chat checks that the same person manages the room, because Community asks it
with the person's own Network token (`POST ${OV_CHAT_INTERNAL_URL}/api/chat/rooms/:room/attachments`,
`{ service: 'community', resource: <space>, title }`). So services cannot attach (a service has no
person's token; moderator services may detach), and no capability or grant is involved. Chat's refusals
come back as `chat_room.not_owner` (403), `chat_room.not_found` (404: no such room, or a private one the
person is not in) and `chat_room.unavailable` (503/502); on the page they are a notice. Attaching the same
room again is a no-op; another room replaces it (Chat is told the space let go of the old one, best
effort); detaching removes Community's link and asks Chat to drop its side when the person may. Community
keeps the link in `space_chat_rooms` (the room's id, slug, and its name, kind and visibility as Chat
answered). No event is published for it (no contract has one yet).

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
  and filtered at read time), the Discord relay (not queued; when gated later, what was waiting is
  skipped and what was sent is deleted on Discord; re-checked at send), the sitemap, the RSS feeds
  (a gated space's feed is 404) and JSON-LD; a member's view of a gated thread is `noindex` as well.
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

Off unless `DISCORD_RELAY_ENABLED=true`, and inert without the owner's webhooks, mappings and bot
token. Setup, owner steps, limits and operations: [docs/discord-relay.md](docs/discord-relay.md).

- **Out**: a new thread in a mapped public space is announced through the mapping's Discord
  webhook ("New thread in s/<space> by <name>", title, excerpt, link); its replies follow into the
  same channel (or the Discord thread the mapping names); edits PATCH and deletes (or gating a
  thread members-only) DELETE the Discord messages through the **external message map**
  (`relay_message_map`, unique both ways; WS-J task 5). Creates are queued by the relay's
  **Events worker** from Community's own `community.thread.*` / `community.post.*` read back from
  OpenVibe.Events' pull API with a stored cursor (`relay_cursors`; WS-J task 6), or by the forum
  itself when the worker is off (no `EVENTS_URL` / client secret, or `DISCORD_RELAY_EVENTS=off`).
  Dedupe keys in `relay_deliveries` mean nothing is queued or posted twice.
- **In** (`DISCORD_RELAY_INBOUND=on`, `DISCORD_BOT_TOKEN`, `inbound: true` on the mapping): a
  Discord gateway client (Node 22's WebSocket; intents GUILD_MESSAGES and MESSAGE_CONTENT) turns
  replies to relayed messages in mapped channels into posts with origin `discord`, attributed to
  the Discord name only (never to anyone on the site), size- and rate-limited, mentions defused;
  edits and deletes on Discord follow through the map.
- **Loop prevention**: origin `discord` never goes out (checked when queueing and sending);
  webhook, bot and system messages never come in. Members/staff spaces and VIP members-only
  content never leave the site.
- **Secrets**: a mapping names the environment variable holding the webhook URL
  (`webhook_url_ref`, allow-listed `DISCORD_WEBHOOK_*` or exactly `DISCORD_RELAY_WEBHOOK_VARS`);
  the URL and the bot token never enter the database or any API response.
- **Retries and the dead letter**: network errors, timeouts, 5xx, 429 and an unset variable are
  retried with exponential backoff up to `DISCORD_RELAY_MAX_ATTEMPTS`, then the delivery is
  `failed` (the dead letter); other 4xx fail at once. Mentions are disabled on every message.
- **Staff** (admin/global_mod browsers, or services with `community.comment.moderate`):
  `GET /api/v1/relay/status` (queue, Events worker cursor/lag/errors/gaps, gateway state),
  `GET /api/v1/relay/deliveries?status=failed`, `POST /api/v1/relay/deliveries/:id/retry|drop`,
  `GET /api/v1/relay/inbound` and `POST /api/v1/relay/inbound/:id/dismiss` (inbound failures),
  `GET|POST /api/v1/relay/mappings`, `PUT /api/v1/relay/mappings/:id`.

## Pulse

A read model of public activity across the network, with provenance (`pulse_items`, unique
per source service/type/id).

- **Community's own**: new public pastes written by a person (not burn-after-read, not NSFW),
  new threads and replies in public spaces, and submissions once accepted — recorded at write time,
  removed when deleted, made non-public, withdrawn or rejected, and re-checked against their source
  on every read, so private, unlisted or unreviewed things never show.
- **Other services** publish with `community.pulse.write`:
  `POST /api/v1/pulse/items { ref, title, url, origin?, occurred_at?, visibility? }` — the
  ref's `service` must be the caller's own (`svc:live` → `live`), `visibility` other than
  `public` is refused, `X-OV-Subject` names the person for origin `user`. Re-posting a source
  updates its title and link; origin, actor and time stay the first record's.
  `DELETE /api/v1/pulse/items/:service/:type/:id` retracts one.
- **From Events** (`POST /internal/events`, `server/pulse/consumer.js`):
  - go-lives (`live.stream.started`), plus public, indexable Blog posts, Wiki pages and News stories;
  - game milestones (roadmap WS-M task 2): Network's `network.module.updated` for a person's
    `games.progress.summary`, whose `level` is a public field. The first record seen for a person is a
    baseline. Each later record that crosses a multiple of 5 becomes one item, "Reached level 10 in Scraplandia"
    (Games · level), with the person as actor. The last level per person is kept in `game_progress`.
- **Reading**: `GET /api/v1/pulse?origin=user|ai|system&after=<cursor>&limit=` (newest first,
  keyset cursor), and the `/pulse` page. AI items carry `label: 'AI'` and never an actor —
  they are never attributed to a person (roadmap §33); system items name no one either.

## Submissions

Clips, art, ideas and reports people send in for community review (`submissions`, migration
`0003_submissions.sql`; `server/submissions/`). They have a table of their own and nothing to do with
the forum, so they stay here when spaces move to a service of their own.

- **Who submits**: a signed-in person, from the browser (`ov_token` cookie, or `Authorization: Bearer`
  from another OpenVibe site through CORS). The author is the JWT's `subject_id` (`usr_…`) — never a
  body field. Signed out: 401 `auth.required` (the form sends you to sign in). Services cannot submit:
  openvibe-contracts has no submission capability yet (403 `capability.denied`). At most 10 a day per
  person (429 `submission.daily_limit`).
- **What**: `kind` (`clip`, `art`, `idea`, `report`), `title` (200), `body` (Markdown, 10 000), an http(s)
  `url` and/or a `media_ref` (an OpenVibe.Media object, `med_…`: the bytes stay in Media). A clip or art
  needs a link or a Media object.
- **Review**: new submissions are `pending`, seen by their author and by discussion moderators
  (site staff, or a service holding `community.comment.moderate` — `discussionModerator`) and 404 for
  everyone else. A moderator accepts or rejects (also a decision already made) with an optional note
  the author sees; the author withdraws while pending or accepted. Accepted ones are public pages
  (canonical, Open Graph, IndexNow), listed at `/submissions` and recorded in [Pulse](#pulse) as the
  author's (origin `user`); pending, rejected and withdrawn ones never are.
- **Pages** work without JavaScript: filters and paging are links, submit, withdraw, accept and
  reject are plain form posts (SameSite=Lax cookie; a foreign `Origin` is refused).

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/submissions?kind=&status=&mine=1&after=&limit=` | anyone | newest first, keyset cursor: accepted ones; `mine=1` your own, any status; moderators any `status` (others asking for one get 403 `submission.moderators_only`) |
| `POST /api/v1/submissions { kind, title, body?, url?, media_ref? }` | a signed-in person | 201 `{ submission }`, `pending` |
| `GET /api/v1/submissions/:slug` | see above | `{ submission }` — `reviewer` and `review_note` only for the author and moderators |
| `POST /api/v1/submissions/:slug/withdraw` | the author | `withdrawn` (409 `submission.not_withdrawable` once rejected or withdrawn) |
| `POST /api/v1/submissions/:slug/review { decision: accept\|reject, note? }` | moderators | `accepted` / `rejected` (409 `submission.withdrawn`) |

Errors are problem+json. Account deletion erases a person's submissions (and their Pulse items) and
unsigns the decisions they made; the export has `submissions.json`; a subject merge moves both.

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

Community checks service tokens against these capabilities (all released in openvibe-contracts,
same shape as its `manifests/capabilities`):

| Id | Status | Used for |
| --- | --- | --- |
| `community.paste.create` / `.write` / `.moderate` | active in contracts | pastes |
| `community.comment.write` | active in contracts (v0.7.0) | comment threads as a person or AI |
| `community.comment.moderate` | active in contracts (v0.7.0) | thread visibility, comment/post/thread moderation, relay admin |
| `community.pulse.write` | active in contracts (v0.7.0) | publishing to Pulse |
| `community.post.create` | active in contracts (v0.7.0) | forum writes |
| `community.space.read` / `.manage`, `community.thread.read`, `community.vote.set`, `community.pulse.read` | active in contracts | spaces, threads, votes and Pulse reads by services and apps |

This repository pins `openvibe-contracts` v0.86.0, which knows every id above, so they all go
through the library's `capabilities.check`. `server/identity/capabilities.js` still decides an id
the installed contracts do not know locally, with the library's own matching rule (the exact id
or a `prefix.*` grant).

Called elsewhere, as the service principal `community` (the OAuth client `community`):

| Service | Grant | Why |
| --- | --- | --- |
| OpenVibe.Network | `identity.subject.resolve`; `network.modules.write` on `community.profile` | author names and avatars; the profile module |
| OpenVibe.Media | `media.object.upload` | new screenshots and forum attachments |
| OpenVibe.VIP | `vip.resource.policy.evaluate` | members-only spaces and threads |
| OpenVibe.Events | `events.event.publish`, `events.subscription.manage` | the outbox relay; Pulse, account and block subscriptions created at boot |

A space's chat room is attached with the signed-in person's own Network token (no service grant).

### Per-actor limits

Every API router also limits who calls it, once the viewer is resolved and before the route does any
work (`server/actor-limits.js`, openvibe-sdk/limits, roadmap WS-R task 4). The per-address `/api/`
limit and the per-person content limits (cooldowns, writes a minute, daily caps) stay. Counted: a
person as `user:usr_…` (their own token, or named by a service or app in `X-OV-Subject`); a
first-party service relaying a signed-out visitor by the address it forwards; a service or app acting
as itself (moderation, AI output, Pulse) by its principal; a signed-out browser by address. A
first-party service reading for itself is not counted on reads. Past a limit: `429` problem+json
`rate_limited` with `Retry-After`, one `[Limits]` log line and `community_rate_limited_total{limit,window}`.

| Routes | Per caller |
| --- | --- |
| Reads of each API (pastes, comments, forum, Pulse, relay) | `COMMUNITY_LIMITS_MINUTE` / `COMMUNITY_LIMITS_HOUR` (120 a minute, 3000 an hour) |
| Comment, paste comment and reply create | 20 / 300 |
| Thread create, crosspost; space create | 10 / 60 |
| Paste create 30 / 600; screenshot 20 / 300; fork 20 / 300; AI summary 60 / 1200 | as listed |
| Edits (comments, posts, pastes, thread category and members-only) | 30 / 300 |
| Deletes and moderation (visibility, comment, post, paste deletes) | 60 / 600 |
| Votes, reactions, likes and copies | 120 / 1200 |
| Space settings, categories, status, state, groups, chat room; relay changes | 30 / 300 |
| Attachment upload 20 / 200; paste censor 20 / 200; bulk and fork cleanups 10 / 100 | as listed |
| Thread resolve 60 / 1200; Pulse item post and retract 60 / 1200 | as listed |

Never limited: `/api/health`, `/api/ready`, `/release.json`, `/metrics` and the signed Events
deliveries at `/internal/events` (they carry token cutoffs and account deletions). Pages keep their
per-address form limits. `test/actor-limits.test.js`.

## SEO

Discovery is written by `openvibe-shared/seo`; Community only supplies the data
(`server/discovery.js`, `server/render/jsonld.js`). Every page head comes from `seo.headTags`
(description, canonical, robots, Open Graph + Twitter card, JSON-LD) plus `seo.pageSummary`
(an `ai-summary` meta and a `WebPage` JSON-LD), with `article:*` times on pastes. JSON-LD:
`WebSite` on the home page, `Article`/`ImageObject` with author and `datePublished` on paste
pages, `DiscussionForumPosting` on threads, `BreadcrumbList` everywhere.
Unlisted/private pastes, search result pages and members/staff spaces are `noindex`. The
sitemap lists home, `/pastes`, the latest public pastes, `/s`, `/pulse`, public spaces and
their latest threads (rebuilt at most hourly). `/robots.txt` welcomes search and AI crawlers
and keeps them out of `/api/`, `/auth/`, `/my`, `/new`, `/s/*/new` and `?sso=` URLs;
`/llms.txt` maps the site and `/llms-full.txt` carries the latest public threads and text pastes
in full (no NSFW, no burn-after-read, nothing members-only).

Cache headers come from `openvibe-shared/cache-policy`: a static file at its current `?v=` hash
is immutable for a year, any other static file is 5 minutes with a day of stale-while-revalidate,
pages (rendered for the person reading them), raw and download are `private, no-store`, and
robots/llms/sitemap are public for 1 h, `/feed.xml` 15 min and the thread feeds 5 min.

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
| `OV_LIVE_URL` | `https://openvibe.live` | Author links, avatars, legal pages |
| `OV_MEDIA_URL` | `https://openvibe.media` | Raw text + screenshots |
| `OV_MEDIA_INTERNAL_URL` | `http://127.0.0.1:4100` | Media file store for new screenshots |
| `DATABASE_URL`, `DATABASE_DIRECT_URL` | unset (development: embedded PGlite in `data/pglite`) | PostgreSQL through PgBouncer, and the owner's direct connection for migrations (written by OpenVibe.Host `roles/data/add-service.sh community`) |
| `VALKEY_URL`, `VALKEY_PREFIX` | unset | per-actor limit counters shared across processes |
| `API_CORS_ORIGINS` | Live, Media, Network, Tools, Games origins | Browser origins that may call `/api/v1/comments` and `/api/v1/pulse` with a Bearer JWT |
| `DISCORD_RELAY_ENABLED` | off | `true` turns the Discord relay on ([docs/discord-relay.md](docs/discord-relay.md)) |
| `DISCORD_RELAY_POLL_MS` / `DISCORD_RELAY_BACKOFF_MS` / `DISCORD_RELAY_MAX_ATTEMPTS` | `30000` / `30000` / `6` | Relay sender cadence, first retry delay, attempts before `failed` (the dead letter) |
| *(any name)* e.g. `DISCORD_WEBHOOK_FEEDBACK` | — | A Discord webhook URL, named by a relay mapping's `webhook_url_ref` |
| `DISCORD_RELAY_EVENTS` / `DISCORD_RELAY_EVENTS_POLL_MS` | on / `5000` | The relay's Events worker (needs `EVENTS_URL` and the client secret); `off` leaves creates to the forum |
| `DISCORD_RELAY_INBOUND` / `DISCORD_BOT_TOKEN` | off / — | Replies from Discord through the gateway (a bot with the MESSAGE CONTENT intent) |
| `DISCORD_GATEWAY_URL` | `wss://gateway.discord.gg/?v=10&encoding=json` | The Discord gateway |
| `DISCORD_RELAY_INBOUND_PER_MINUTE` / `DISCORD_RELAY_INBOUND_MAX_CHARS` | `6` / `4000` | Inbound limits per Discord author per mapping, and per message |
| `VIEW_HASH_SECRET` | derived from the client secret | Salt for hashed visitor ids in view counts |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-http local dev |
| `OV_VIP_INTERNAL_URL` | `http://127.0.0.1:4620` | OpenVibe.VIP's API (members-only spaces and threads) |
| `OV_CHAT_INTERNAL_URL` | `http://127.0.0.1:4400` | OpenVibe.Chat's API (a space's chat room) |
| `OV_CHAT_URL` | `https://openvibe.chat` | Public Chat site, for the room links |
| `CHAT_TIMEOUT_MS` | `4000` | One Chat call |
| `OV_VIP_URL` | `https://openvibe.vip` | Public VIP site, for join links |
| `VIP_TIMEOUT_MS` | `2000` | One VIP call |
| `VIP_CACHE_TTL_MS` / `VIP_CACHE_DENY_TTL_MS` / `VIP_CACHE_UNAVAILABLE_TTL_MS` | `30000` / `10000` / `2000` | How long a yes / no / failure is cached (the yes TTL is the convergence bound) |
| `INDEXNOW_KEY` | unset (IndexNow off) | IndexNow key: served at `/<key>.txt`, and a public, indexable page appearing, changing or going away pings the engines |

## Run

```
npm install
npm start          # http://127.0.0.1:4200
npm test           # mocks Live, Network and Media in-process; no network needed
npm run n-1:record # after a deploy: the N-1 fixtures from the deployed commit (or pass <ref>)
```

`test/n-1.test.js` (roadmap WS-P task 11, in `npm test`) runs the previous release's clients against
this one, from `test/fixtures/n-1/`: every call `community.js`, the templates' forms and the
openvibe-sdk community client make, and every link, script and form of the pages that release served,
each answered compatibly (status, JSON, the response fields the client reads); then this release must
keep every migration that release ran byte for byte and only add. After each deploy, record the
release now in production as the next N-1 and commit `test/fixtures/n-1/`.

## Acceptance

`npm test` runs every `test/*.test.js` with mock Live, Network and Media and a real RS256 key, no
network. What they prove, among others: the paste API as the browser clients use it and the import
(`pastes-api`, `import`); comment threads, the forum and its server-rendered pages (`comments`, `forum`,
`forum-ssr`, `ssr`); members-only gates that fail closed (`members-only`); private things stay private on
every read path and nobody acts on someone else's ids (`security-private`, `security-idor`); SSRF,
secrets, open redirects (`security-ssrf`, `security-secrets`, `open-redirect`); Pulse and the Events
consumer (`pulse`, `pulse-consumer`, `events`); revocation, blocks, account export and deletion
(`revocation`, `blocks`, `account-data`); the Discord relay (`relay*`); per-actor limits
(`actor-limits`); submissions from the form to review, the page and Pulse (`submissions`); graceful
shutdown (`shutdown`); and the previous release against this one (`n-1`).

## Security

Reporting a vulnerability: [SECURITY.md](SECURITY.md). The rules the code keeps:

- **Auth.** Browsers use Network JWTs (Bearer or `ov_token`); services use tokens for audience
  `openvibe.community` with the route's capability, and name the person in `X-OV-Subject`. Identity is
  never read from bodies or queries; a token issued before a person's `token_valid_after` is refused.
- **Private data.** Unlisted and private pastes get unguessable slugs, burn-after-read pastes are read
  once, members-only spaces and threads fail closed when VIP is unreachable, screenshots lose their
  EXIF/XMP metadata, and view counts use hashed visitor ids (`VIEW_HASH_SECRET`).
- **Egress.** Community calls only its configured Network, Live, Media, VIP, Chat and Events hosts,
  and Discord (webhooks named by variable, the gateway) when the relay is on.
- **Secrets.** `OV_OAUTH_CLIENT_SECRET`, `COMMUNITY_EVENTS_SECRET`, `VIEW_HASH_SECRET`,
  `DISCORD_BOT_TOKEN` and the Discord webhook variables live in `/etc/openvibe/community.env` (0600), by
  name only; a relay mapping stores a variable's name, never the URL.

## Deploy

```
/opt/openvibe.community                     # git checkout, `npm ci --omit=dev`
/etc/openvibe/community.env                 # secrets (0600)
deploy/systemd/openvibe-community.service   # → /etc/systemd/system/, User=ubuntu, port 4200
deploy/nginx/openvibe.community.conf        # → /etc/nginx/sites-available/, TLS from
                                            #   /etc/letsencrypt/live/openvibe.community/
```

Production deploys with `sudo ovhost deploy community` on the host (strategy `git-checkout`: fetch,
fast-forward `/opt/openvibe.community`, install on a lockfile change, restart, wait for `/api/ready`).
The unit is `openvibe-community.service` on `127.0.0.1:4200`, the env file `/etc/openvibe/community.env`. The database is
`ov_community` on the host's data role (`sudo /opt/openvibe.host/roles/data/add-service.sh community` writes its settings); the
release migrates it at boot. After a deploy, record the N-1 fixtures (`npm run n-1:record`).
Rollback: ovhost puts the previous sha back by itself when `/api/ready` does not answer 2xx after the
restart; afterwards `sudo ovhost rollback community --to <sha>`. Migrations only add tables and columns.

The schema
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
  db.js               PostgreSQL (openvibe-sdk/db): initDb/getDb, migrations/ applied at boot
  auth/routes.js      OAuth2 client (login/callback/logout/me/refresh), optionalAuth
  identity/viewer.js  who is calling: browser JWT, service token (+ X-OV-* headers), anonymous
  identity/network.js Network resolve-batch client + subject_projection cache
  media/files.js      new screenshot bytes → Media's file store (service token)
  media/strip-metadata.js  EXIF/XMP/text chunks out of JPEG/PNG/WebP without re-encoding
  live-client.js      (removed: Community is the only paste authority)
  pastes/proxy.js     (removed: the /api/pastes proxy to Live is gone)
  pastes/api.js       native /api/pastes/*
  pastes/service.js   paste rules: visibility, limits, burn-after-read, views, shapes
  pastes/store.js     pure SQL over pastes / versions / likes / projections (comments: comments/store.js)
  pastes/source.js    where pages read pastes from (the store)
  pastes/catalog.js   recent public pastes: trending, related, language filter
  comments/           typed comment threads: store (SQL), service (rules), api (/api/v1/comments),
                      routes (the /c/:accessId page), live-import (Live's old VOD/clip comments)
  forum/              spaces/threads/posts: store, service, api (/api/v1/spaces, /posts), routes (pages)
  vip/                OpenVibe.VIP gate for members-only spaces/threads (index.js) + the vendored client
  pulse/              Pulse read model: store, service (hooks + ingest), api (/api/v1/pulse)
  submissions/        clips, art, ideas, reports for review: store, service, api (/api/v1/submissions), routes (pages)
  relay/              Discord relay: discord.js (queue, sender, backoff, message map), events-worker.js (creates
                      from Events), discord-gateway.js + inbound.js (replies from Discord), api (/api/v1/relay)
  http/v1.js          /api/v1 helpers: problem errors, capability guards, cursors, CORS
  identity/capabilities.js  capability checks; discussion staff/moderators
  identity/authors.js author display from subject_projection; the AI label
  votes.js            race-safe up/down votes (comments, threads)
  limits.js           per-person write limits
  render/layout.js    page shell: SEO head (openvibe-shared/seo), shared chrome, hashed assets
  render/jsonld.js    JSON-LD builders (WebSite, breadcrumbs, paste, thread, authors)
  render/pages.js     home / browse / paste / new / my / error templates
  render/forum.js     spaces / threads / thread / new-thread / members-only teaser templates
  render/pulse.js     the /pulse page
  render/submissions.js  the submissions list, a submission's page, the review queue
  render/comments.js  a comment thread's own page
  render/markdown.js  the safe Markdown subset for posts
  render/highlight.js highlight.js wrapper, language list, download extensions
  discovery.js        robots disallow set, llms sections, sitemap rows (1 h), feed items
public/               css/community.css, js/community.js, favicon.svg, og-default.png
(openvibe-shared is the pinned OpenVibe.Shared v2.2.0 release, installed by npm)
deploy/               systemd unit, nginx vhost
test/                 run.js + *.test.js (mock Network and Media with a real RS256 key)
docs/discord-relay.md  the Discord relay: how it works, owner steps, staff API, limits
```

## What is next

Spaces per streamer, game and project (with membership), the Discord relay's production round
trip (owner steps in [docs/discord-relay.md](docs/discord-relay.md)), visibility changes for
comment threads arriving through Events, and dropping the read-only `paste_comments` table a
release after paste comments moved onto the typed comment threads. [Submissions](#submissions) are here: send yours at [/submissions](https://openvibe.community/submissions).

## Related services

- Identity/SSO: https://openvibe.network (OpenVibers/OpenVibe.Network)
- Streaming: https://openvibe.live (OpenVibers/OpenVibe.Live)
- Tools: https://openvibe.tools (OpenVibers/OpenVibe.Tools)
- Media: https://openvibe.media (OpenVibers/OpenVibe.Media)
- Games: https://openvibe.games (OpenVibers/OpenVibe.Games)
