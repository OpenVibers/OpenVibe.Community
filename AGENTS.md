# AGENTS.md — OpenVibe.Community

## Project overview

The OpenVibe community home: **pastes** (the only authority for them since 2026-09-22), the **forum**
(spaces, threads, posts, votes), the **typed comment threads** every other product embeds, **Pulse**
(the network's public activity), **submissions**, the Discord relay, and members-only gates through
VIP. A small Node.js/Express app, CommonJS, no frontend framework, one PostgreSQL database
(`ov_community`), server-rendered pages with a little progressive JavaScript.

- Origin `https://openvibe.community`, port `4200`, unit `openvibe-community.service`, release root
  `/opt/openvibe.community`.
- The forum moved back here from Space on 2026-10-08; Space redirects its old forum URLs here.
  Space remains the code-hosting / "spaces" product.

## What it owns

- Pastes, their versions, likes, visibility (public/unlisted/private/burn), locked pastes, spam and
  image review, and the `/api/pastes/*` native API. Pages, raw text, screenshots and downloads read
  from the paste store — never from Media (Media redirects its old paste URLs here).
- The typed comment threads every product embeds (`comments` with a type + ref, not a copy of the
  product's content; the product stores only the thread id).
- The forum: spaces, groups, threads, posts, votes, categories, pinned starters, the Roadmap space
  (`docs/roadmap/public.json`), a space's Chat room, members-only spaces/threads (VIP).
- Pulse, the network's public activity; submissions and their review queue; the Discord relay.
- `community.*` events, Search documents for public threads, the `community.profile` user module.
- `ov_community` (host data role, ADR-035), Valkey for per-actor limits.

Not owned: identity/SSO (Network), file bytes (Media), memberships (VIP), chat rooms (Chat), the
contents of products whose threads it hosts.

## Who calls it, and whom it calls

- Callers: people in the browser; Live (old VOD/clip comment imports), every product embedding a
  comment thread, Chat/Space linking a forum thread, and services with a Network service token
  audience `openvibe.community` and the route's capability.
- Depends on: **Network** (SSO, JWKS, service tokens, `identity.subject.resolve`, the profile module);
  **Media** (screenshots/attachments; metadata stripped before upload); **VIP** (members-only gates,
  fails closed); **Chat** (a space's room); **Events** (outbox and the Pulse/account subscriptions);
  **Vision** (`OV_VISION_URL`, unsafe-image review; unset means no image review); Search for public
  thread documents; `openvibe-contracts`, `openvibe-sdk` and `openvibe-shared` pins.

## Repository map

- **Entry:** [server/index.js](server/index.js) — database/migrations first, app, Discord relay, Events,
  Roadmap and starter sync; graceful stop.
- **App:** [server/app.js](server/app.js) — helmet/CSP, `/auth`, `/api/pastes`, `/api/v1/*` (comments,
  spaces, posts, pulse, feed, submissions, profiles, relay, resources), `/shared`, `/internal/events`,
  server-rendered pages.
- **Config/db:** [server/config.js](server/config.js), [server/db.js](server/db.js).
- **Pastes:** [server/pastes/](server/pastes/) — `api.js`, `service.js`, `store.js`, `catalog.js`,
  `review.js`, `content-hash.js`, `spam.js`.
- **Comments:** [server/comments/](server/comments/) — `service.js`, `api.js`, `store.js`, `routes.js`.
- **Forum:** [server/forum/](server/forum/) — `service.js`, `api.js`, `routes.js`, `roadmap.js`,
  `starters.js`.
- **Pulse/submissions/relay:** [server/pulse/](server/pulse/), [server/submissions/](server/submissions/),
  [server/relay/](server/relay/).
- **Identity/auth:** [server/identity/](server/identity/), [server/auth/](server/auth/),
  [server/vip/](server/vip/).
- **Render:** [server/render/](server/render/) — pages, comments, forum, feed, pulse, markdown,
  highlight, JSON-LD.
- **Browser:** [public/js/community.js](public/js/community.js), `inline-comments.js`, `composer.js`;
  CSS in [public/css/](public/css/); assets in [public/assets/](public/assets/).
- **Deploy:** [deploy/systemd/openvibe-community.service](deploy/systemd/openvibe-community.service),
  [deploy/nginx/openvibe.community.conf](deploy/nginx/openvibe.community.conf).

## Commands

```bash
npm ci
npm run dev                   # NODE_ENV=development node server/index.js
npm start                     # node server/index.js, http://127.0.0.1:4200
npm test                      # test/run.js, PGlite, mock Live/Network
npm run test:pg               # same suite on PostgreSQL (COMMUNITY_TEST_STORE=pg)
npm test -- seo proxy         # filter by file name; --strict makes a skip fail
npm run n-1:record            # record the N-1 fixtures after a deploy
ov test                       # the harness's sharded run of what the change reaches
```

## Database and migrations

`ov_community` on the host's data role (ADR-035); embedded PGlite in development/tests. Async through
`openvibe-sdk/db`. Migrations are `migrations/NNNN_*.sql`, applied at boot; the schema is created
idempotently in every mode (comments, forum, Pulse and the relay live here whichever service owns
pastes), and three seed spaces are inserted. Never edit a migration that has run; add a new number.
A rollback is safe because migrations only add tables and columns.

## Auth, identity and comments

- People are **Network subjects** (`usr_…`, `gst_…`), never service-local integers. A browser's owner
  is the JWT's `subject_id` (older tokens resolved once through Network and cached in `legacy_id_map`);
  names/avatars come from `subject_projection`, refreshed through the Network's resolve-batch.
- Identity is **never read from bodies or queries**; a token issued before `token_valid_after` is
  refused. `openvibe-sdk/sso` owns the cookie flow.
- Service callers need a service token audience `openvibe.community` and the route's capability
  (`community.paste.create|write|moderate`, the comment/forum equivalents, …). An `X-OV-Subject` scopes
  a first-party service call.
- Comments are typed: a product passes its own ref and gets a thread id; it never stores comment text.
- Members-only spaces/threads go through VIP and **fail closed**; locked pastes are sealed and never
  readable from the text path ([docs/locked-pastes.md](docs/locked-pastes.md)).

## Frontend loading model

Every page is server-rendered — crawlers and no-JS readers get the whole thing — with small no-build
scripts for pagination, copy buttons, the upload path and the inline composer. There is no SPA,
bundler or transpiler. `openvibe-shared` supplies the Frame, the share sheet and `/shared/*` from the
pinned node_modules (including `/shared/ov-glyphs.js`). **Icons are OpenVibe glyphs and brand logos,
never Font Awesome** (see the pitfall). Markdown is rendered through the local renderer, which escapes
first and only links http(s).

## Deploy

`sudo ovhost deploy community` (git-checkout: fetch, fast-forward `/opt/openvibe.community`, install
on a lockfile change, restart, wait for `/api/ready`). Unit `openvibe-community.service` on
`127.0.0.1:4200`, env `/etc/openvibe/community.env` (0600), vhost
[deploy/nginx/openvibe.community.conf](deploy/nginx/openvibe.community.conf). Database `ov_community`
on the data role (`add-service.sh community`). Record the N-1 fixtures after a deploy
(`npm run n-1:record`). Rollback `sudo ovhost rollback community --to <sha>`.

## Tests

`npm test` runs each `test/*.test.js` in its own process through `openvibe-shared/test-runner`
(60 s/file) with in-process Live/Network mocks. Notable guards: `test/no-font-awesome.test.js` (no FA
link, font or unknown `fa-` name; every icon page loads the glyph drop-in),
`test/empty-states.test.js`, `test/markdown.test.js` (an unsafe
scheme never becomes a link), `test/members-only.test.js`, `test/privacy.test.js`, the Pulse source
rules, `test/nginx-auth-limit.test.js`, `test/nginx-internal-paths.test.js` and the N-1 fixtures.
`ov test` runs the same.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; domain logic in `server/pastes|comments|forum`,
  rendering in `server/render/`, no SQL in routes.
- Escape every interpolated value (`esc`), embed JSON with the `<`-escaping helper; never build HTML
  from unsanitised Markdown.
- Errors are small JSON/problem bodies with stable codes; never leak a private paste, a member-only
  body or another person's data through an error or a cache header.
- Works with JavaScript off; a feature that requires a script must not be the only path.

## Pitfalls

- **No Font Awesome.** `test/no-font-awesome.test.js` fails on a page/stylesheet that links it, or on
  an `fa-` name no glyph/brand draws. Use `openvibe-shared/glyphs` and `openvibe-shared/brands`.
- **Community is the only paste authority.** Do not add a second store or read pastes from Media/Live.
- **Identity comes from the verified token only** — never a body or a query.
- **Locked pastes are sealed at rest**, readable only through their gate; a share row must not make an
  unpublished/private paste readable.
- **Pulse excludes unlisted, private, burn, NSFW and AI pastes**; do not "fix" a missing item by
  widening that filter.
- **Strip image metadata before upload**; a 1×1 PNG's tEXt chunk must not reach Media.
- **Members-only content fails closed** when VIP is unavailable: teaser, not body.
- **Phone first is a standing product rule.** There is no automated overflow test here: check a
  390 px viewport by hand (and the forum/commenter grids) before shipping a layout change.
- **Empty states are part of the product**; a blank page for no posts/pastes/comments is a bug.
- **`/internal/*` and `/metrics` stay off the public vhost** (nginx tests).
- **N-1 fixtures** are recorded after a deploy; keep them current.

## Documentation

- [README.md](README.md) — every surface, the endpoint list, principles, acceptance and deploy.
- [docs/locked-pastes.md](docs/locked-pastes.md), [docs/sharing.md](docs/sharing.md),
  [docs/discord-relay.md](docs/discord-relay.md).
- [docs/forum/](docs/forum/), [docs/roadmap/](docs/roadmap/), [docs/screenshots/](docs/screenshots/).
- `openvibe-contracts` holds `community.*` shapes/capabilities; VIP and Media own their own.
