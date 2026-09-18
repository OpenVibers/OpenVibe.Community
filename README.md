# OpenVibe.Community

**https://openvibe.community — the people of OpenVibe.**

The community hub of the OpenVibe network: community-run, open source, free speech within
the rules. Today it is the home of **pastes** (code, text and screenshots with a link);
spaces, threads and submissions follow.

It is a small Node/Express app (CommonJS, no framework, no database of its own) that
server-renders every page — crawlers and no-JS readers get the whole thing — and adds a
little progressive JavaScript for pagination, copy buttons and the upload path.

## How it fits the network

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

## Endpoints

Pages (server-rendered HTML):

| Route | What |
| --- | --- |
| `GET /` | Home: hero, latest pastes, most viewed, "start a paste" CTA, what is coming |
| `GET /pastes` | Browse — `?q=` search, `?sort=new\|views`, `?lang=`, `?page=` |
| `GET /p/:slug` | Paste page — highlighted body (server-side, highlight.js), raw/download/copy/fork/share, screenshot, related |
| `GET /p/:slug/raw` | 302 → `https://openvibe.media/p/:slug/raw` |
| `GET /p/:slug/screenshot` | 302 → `https://openvibe.media/p/:slug/screenshot` |
| `GET /p/:slug/download` | The text as an attachment (`slug.ext`); screenshots bounce to Media |
| `GET /new`, `POST /new` | Create (signed-in or anonymous). `?fork=slug` prefills. The POST is the no-JS fallback; with JS the form talks to `/api/pastes` |
| `GET /my` | The signed-in user's pastes (public, unlisted and private); anonymous → sign-in |

API and machine endpoints:

| Route | What |
| --- | --- |
| `ANY /api/pastes/*` | Transparent proxy to Live `/api/pastes/*` — list, get, create, `screenshot` (multipart), `:slug/copy`, `:slug/like`, comments, delete… bodies stream through untouched |
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
| `COOKIE_SECURE` | `true` in production | Set `false` for plain-http local dev |

## Run

```
npm install
npm start          # http://127.0.0.1:4200
npm test           # mocks Live + Network in-process; no network needed
```

## Deploy

```
/opt/openvibe.community                     # git checkout, `npm ci --omit=dev`
/etc/openvibe/community.env                 # secrets (0600)
deploy/systemd/openvibe-community.service   # → /etc/systemd/system/, User=openvibe, port 4200
deploy/nginx/openvibe.community.conf        # → /etc/nginx/sites-available/, TLS from
                                            #   /etc/letsencrypt/live/openvibe.community/
```

Update: `git pull && npm ci --omit=dev && systemctl restart openvibe-community`. Nothing is
written to disk by the app; there is no migration step.

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
  auth/routes.js      OAuth2 client (login/callback/logout/me/refresh), optionalAuth
  live-client.js      server-side reads of Live's /api/pastes for rendered pages
  pastes/proxy.js     /api/pastes/* → Live (streams bodies, forwards token + address)
  pastes/catalog.js   cached window of recent public pastes: trending, related, language filter
  render/layout.js    page shell: SEO head, shared chrome, hashed assets
  render/pages.js     home / browse / paste / new / my / error templates
  render/highlight.js highlight.js wrapper, language list, download extensions
  seo.js              robots, sitemap, RSS, JSON-LD builders
public/               css/community.css, js/community.js, favicon.svg, og-default.png
vendor/openvibe-shared  unmodified copy of OpenVibe.Network/packages/openvibe-shared
deploy/               systemd unit, nginx vhost
test/                 run.js + *.test.js (mock Live + mock Network with a real RS256 key)
```

## What is next (phase 2)

Spaces (per-streamer / per-topic communities), threads (long-form forum discussion) and
submissions (clips, art, ideas, reports for community review). These need storage of their
own — Community has none today — and moderation tooling; the paste pages, auth layer and
chrome are built to be reused by them.

## Related services

- Identity/SSO: https://openvibe.network (OpenVibers/OpenVibe.Network)
- Streaming: https://openvibe.live (OpenVibers/OpenVibe.Live)
- Tools: https://openvibe.tools (OpenVibers/OpenVibe.Tools)
- Media: https://openvibe.media (OpenVibers/OpenVibe.Media)
- Games: https://openvibe.games (OpenVibers/OpenVibe.Games)
