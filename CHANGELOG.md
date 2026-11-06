# Changelog

## Unreleased

- Sharing reaches pastes (design 2026-11-06, the pilot): `openvibe-sdk` v0.85.0 and `openvibe-shared` v4.114.0, with
  `openvibe-contracts` v0.291.0. `migrations/0015_sharing.sql` adds openvibe-sdk/share's tables (expand), and
  `migrations/0016_sharing_backfill.sql` registers every existing paste once (public→public, unlisted→link,
  private→private, owner = its owner subject; an ownerless paste belongs to Community itself). Every read path asks the
  one check, `canView`: the page, raw, download, the screenshot proxy (a Media URL is never put in HTML), the JSON API,
  comments, the lists, the feed, llms, the sitemap and link previews (people/private pages give a generic card and no
  paste JSON-LD). A person not on the list gets a 404 with `OVShare.gate` ("Ask for access" signed in, "Sign in"
  otherwise); a pending transfer's recipient previews the paste with `OVShare.offer`. The page's Share button is
  `data-ov-share-sheet` against the uniform `/api/v1/paste/:slug/share` routes. `POST /api/pastes` takes `audience`,
  `members` and `transfer_to` (one call makes a paste only two people can open and offers it). Screenshots upload to
  Media as private objects; `npm run screenshots:private` re-hosts the existing unlisted ones. Burn-after-reading
  pastes cannot use `people`. `docs/sharing.md` has the curls; `/docs/sharing`, `/llms.txt` and `/llms-full.txt` link it.

- Threads carry content labels (L1, labels and choices, 2026-11-02): `migrations/0013_thread_content_labels.sql` adds
  `threads.content_labels` (`{ labels, suggested }`, common.content-labels@1). The author or a moderator sets them on the
  new-thread form, in a Labels box on the thread, or with `PUT /api/v1/spaces/:space/threads/:slug/labels`. Lists and
  thread pages in both styles show them in words and carry `data-ov-labels` with the author's subject, so each reader's
  own choice on openvibe.network (Shared's ov-labels.js) shows, blurs or hides them, and the author always sees their
  own; a thread's own page is opened, so hide covers it instead of emptying the page. Ticking nothing clears them.
- The forum publishes its moderation (market outcome 5): `migrations/0012_forum_moderation_log.sql` adds `forum_moderation_log`, and every moderator lock, unlock, pin, unpin, post/thread delete and status change writes one row in the same transaction, with the optional rule and reason the forms now take. The row names the actor's role only (staff, moderator, owner, automatic), never their Network subject. `GET /s/:space/log` (and `GET /api/v1/spaces/:space/moderation-log`) shows the newest 100, with a removed thread shown as "a removed thread"; public spaces publish it, private spaces keep the same sign-in rule as their page.
- Each thread has an RSS feed of its newest 50 posts (`GET /s/:space/t/:slug/feed.xml`), the space and thread pages advertise their feeds in the head, and each shows a small RSS link.

- The forum is Community's again (owner decision, 2026-10-08). Reverts #19: `server/forum/*`, `server/relay/*`, `server/{chat-rooms,votes}.js`, `server/vip/*`, `server/render/{board,forum}.js` and their pages, feeds, search documents, events, migrations and suites are back, and `/s`, `/s/*` serve the forum here instead of a 301 to Space. Later changes are kept: the pin bumps, the Events move to openvibe.events (`connect-src`, the Pulse stream URL), and the `community.*` capability ids. `migrations/0006_contract_forum.sql` is gone: it drops the forum tables and never ran in production, so it must not. OpenVibe.Space becomes code hosting and "spaces" and redirects every forum URL here.
- The forum capability ids Community serves (`community.post.create`, `community.space.read`, `community.space.manage`, `community.thread.read`) are retired in the currently pinned openvibe-contracts; until the release that makes them active again, `server/identity/capabilities.js` decides those grants locally with the library's own matching rule.
- `test/account-data.test.js` closes its database; the post-#19 SDK left PGlite's idle timer keeping the process alive, so the file never exited.
