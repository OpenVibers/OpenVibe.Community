# Changelog

## Unreleased

- The forum is Community's again (owner decision, 2026-10-08). Reverts #19: `server/forum/*`, `server/relay/*`, `server/{chat-rooms,votes}.js`, `server/vip/*`, `server/render/{board,forum}.js` and their pages, feeds, search documents, events, migrations and suites are back, and `/s`, `/s/*` serve the forum here instead of a 301 to Space. Later changes are kept: the pin bumps, the Events move to openvibe.events (`connect-src`, the Pulse stream URL), and the `community.*` capability ids. `migrations/0006_contract_forum.sql` is gone: it drops the forum tables and never ran in production, so it must not. OpenVibe.Space becomes code hosting and "spaces" and redirects every forum URL here.
- The forum capability ids Community serves (`community.post.create`, `community.space.read`, `community.space.manage`, `community.thread.read`) are retired in the currently pinned openvibe-contracts; until the release that makes them active again, `server/identity/capabilities.js` decides those grants locally with the library's own matching rule.
- `test/account-data.test.js` closes its database; the post-#19 SDK left PGlite's idle timer keeping the process alive, so the file never exited.
