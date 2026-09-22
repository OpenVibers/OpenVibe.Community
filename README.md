# OpenVibe.Community

**https://openvibe.community — the people of OpenVibe.**

The community hub of the OpenVibe network: community-run, open source, free speech within
the rules. Today it is the home of **pastes** (code, text and screenshots with a link);
spaces, threads and submissions follow.

It is a small Node/Express app (CommonJS, no framework, one SQLite database) that
server-renders every page — crawlers and no-JS readers get the whole thing — and adds a
little progressive JavaScript for pagination, copy buttons and the upload path.

## How it fits the network

Pastes are moving to Community (roadmap Wave 5). `PASTES_AUTHORITY` picks who owns them:

- **`live`** (default, today's production): the table below. Deploying the new code changes
  nothing until the flag flips.
- **`community`**: Community's own database is the authority — see
  [Community as the paste authority](#community-as-the-paste-authority).

| Concern | Where it lives | How Community reaches it |
| --- | --- | --- |
| Paste storage | **OpenVibe.Media** (`pastes` table, `/api/v1/:app/pastes`) | never directly |
| Paste API + account mapping | **OpenVibe.Live** (`/api/pastes/*`) | `OV_LIVE_INTERNAL_URL` (server-side) |
| Identity / SSO | **OpenVibe.Network** (OAuth2 + RS256 JWKS) | OAuth client `community` |
| Raw text, screenshots | OpenVibe.Media public host | 302 from `/p/:slug/raw`, `/p/:slug/screenshot` |
| Shared chrome, themes | `https://openvibe.network/shared/*.js` | loaded in every page |

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
redirects its old paste URLs here after cutover).

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

API and machine endpoints:

| Route | What |
| --- | --- |
| `ANY /api/pastes/*` | `live`: transparent proxy to Live `/api/pastes/*` — list, get, create, `screenshot` (multipart), `:slug/copy`, `:slug/like`, comments, delete… bodies stream through untouched. `community`: the native API (same surface, plus `/:slug/versions`) |
| `GET /api/health`, `GET /api/ready` | Liveness / readiness |
| `GET /auth/login` | → Network `/oauth/authorize`. `?next=` (same-site path, this origin, or `https://openvibe.network/…`), `?silent=1` adds `prompt=none` |
| `GET /auth/callback` | Code exchange; sets cookies. `error=login_required` → `next` + `?sso=none` |
| `GET /auth/logout` | Clears session, sets `ov_sso_hint=guest`, honours `?next=` |
| `GET /auth/me` | Offline-verified profile from `ov_token` |
| `POST /auth/refresh` | Rotate via refresh token |
| `GET /robots.txt`, `GET /sitemap.xml`, `GET /feed.xml` | SEO + RSS of the latest pastes |

Cookies are host-only for `openvibe.community`: `ov_token` (24 h access JWT, JS-readable so
the shared navbar can use it), `ov_refresh` (httpOnly, `/auth`), `ov_sso_hint`
(`account`/`guest`, 1 year, JS-readable — the navbar only tries a silent sign-in when it says
`account`).

## SEO

Every page carries a title, description, canonical, robots, Open Graph + Twitter card and
JSON-LD (`WebSite` on the home page, `Article`/`ImageObject` with author and `datePublished`
on paste pages, `BreadcrumbList` on both). Unlisted/private pastes and search result pages
are `noindex`. The sitemap lists home, `/pastes` and the latest public pastes (cached 1 h).

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
| `VIEW_HASH_SECRET` | derived from the client secret | Salt for hashed visitor ids in view counts |
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-http local dev |

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
is created idempotently at boot (only when `PASTES_AUTHORITY=community`; in `live` mode the
app writes nothing to disk). The database lives in the unit's `StateDirectory`
(`/var/lib/openvibe-community`), so the code tree stays read-only.

Before flipping to `community`, the Network's `community` OAuth client needs the
`identity.subject.resolve` capability (audience `openvibe.network`) and
`media.object.upload` (audience `openvibe.media`), and Live's service client needs the
`community.paste.*` capabilities it will use.

The Network must have the OAuth client `community` registered with redirect
`https://openvibe.community/auth/callback`, and serve the current `openvibe-shared`
`navbar.js` (with `links`/`menu`/`silentLogin` support) for the top links and silent sign-in
to appear.

## Layout

```
server/
  index.js            process entry (listen, shutdown)
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
  render/layout.js    page shell: SEO head, shared chrome, hashed assets
  render/pages.js     home / browse / paste / new / my / error templates
  render/highlight.js highlight.js wrapper, language list, download extensions
  seo.js              robots, sitemap, RSS, JSON-LD builders
public/               css/community.css, js/community.js, favicon.svg, og-default.png
vendor/openvibe-shared  unmodified copy of OpenVibe.Network/packages/openvibe-shared
deploy/               systemd unit, nginx vhost
scripts/import-pastes.js  Media paste bundle importer
test/                 run.js + *.test.js (mock Live, Network and Media with a real RS256 key)
```

## What is next (phase 2)

Spaces (per-streamer / per-topic communities), threads (long-form forum discussion) and
submissions (clips, art, ideas, reports for community review). These need storage of their
own — the paste database is the first — and moderation tooling; the paste pages, auth layer and
chrome are built to be reused by them.

## Related services

- Identity/SSO: https://openvibe.network (OpenVibers/OpenVibe.Network)
- Streaming: https://openvibe.live (OpenVibers/OpenVibe.Live)
- Tools: https://openvibe.tools (OpenVibers/OpenVibe.Tools)
- Media: https://openvibe.media (OpenVibers/OpenVibe.Media)
- Games: https://openvibe.games (OpenVibers/OpenVibe.Games)
