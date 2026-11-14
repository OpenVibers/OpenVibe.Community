# Changelog

## Unreleased

- /pulse is the shared feed now: the same component the menu's Feed tab draws (openvibe-shared's ov-home.js,
  `OpenVibeHome.feed`), on the same Network feed, so the two can never drift apart. Community's own Pulse list —
  its "Everything / People / AI / System" tabs, its rows and its "Older" links — is gone, and so is the Events
  "show N new items" bar it carried. The page renders the first page of that same feed on the server for the
  crawlers and for a reader without JavaScript; the script replaces those cards with the shared ones. When Network
  does not answer, the page still answers and says the feed is loading. Test: `test/pulse.test.js`.

- A comment may carry a file the person uploaded through Media's composer (composer.attachment@1): a video, a
  picture, an audio, a PDF or a text file. The comment names it as `{ media_attachment_id }` (in the JSON and in
  the no-JS form's field), Community asks Media (with its service token, naming the person) whether it exists, is
  the person's and may be carried, keeps it with the comment so it lives as long as the comment does, and stores
  what Media answers: the kind, the type, the poster, the playback (url, mime, ready), the length and the size.
  The public reference carries them, so a page can show a player for a video. Another person's attachment is a
  404, exactly like one that does not exist; an executable is refused; at most four files. The old file upload
  path is untouched. `migrations/0039_comment_attachments_video.sql`. Test: `test/comment-media-attachments.test.js`.

- The forum's reply and new thread boxes and the inline comment thread are the shared composer v2 (openvibe-shared
  4.215.0, `OpenVibeComposer.mount`): the reply and a comment use the comment preset, a new thread the post preset, and
  each keeps its form's action, a reply's parent and its no-JS post. Tests: `test/composer.test.js` at 390 px and the
  shared `test/inline-composer-chrome.test.js`.

- A Live recording, clip or "went live" card names its channel's person: the one subject Community knows by that
  username, none when two share it. 70 of 112 Live recordings and clips since 11-01 had no subject, so the Following
  feed never showed them and one streamer's evening folded as two runs. An update fills a card that had no person; a
  card's person never changes once known. Test: `test/pulse-sources.test.js`.

- The Feed folds a person's run of one kind on one site while each card is within two hours of the run (it was 15
  minutes from the run's first card): 11-11's feed showed one streamer's evening of restarts as nine rows and another's
  morning of uploads as five "added 2 videos" rows. A trending card is skipped when the page already shows its link or
  its title ("Recording: " aside), a folded run's own cards included; before, a trending card could repeat a Pulse
  card further down the page. Test: `test/feed-api.test.js`.

- Community records `orientation applied` on new Media image objects after Media normalizes their EXIF before upload.
  This keeps already-corrected screenshots and attachments out of the later AI orientation queue. Test:
  `test/attachments.test.js`.

- Community paste screenshots and forum attachments now send source image bytes to Media's shared EXIF normalizer
  before upload. Media applies orientation to pixels and removes camera/location metadata; Community stores the
  normalized image hash and byte size. The screenshot upload, censor replacement, and forum attachment paths had
  stripped EXIF before orientation was applied. Tests: `test/attachments.test.js`, `test/paste-sharing.test.js`.

- Keep every Pulse row when paging the Feed, include trending cards within `limit`, and apply live/stream filters after resolving current live status.

- **The wide Feed** (owner, 11-09: "one huge feed of everything, all the data, SDK and API enabled"). Pulse now carries
  every kind the menu's Feed draws — `wiki` (new and updated articles), `quest` (a finished quest's badge), `chat` (a
  busy public room hour), `event` (Today's calendar) and `member` (a day's new Network accounts, "5 people joined
  today") — beside live, clip, video, pic, post, meme, game and update. Wiki and Chat arrive over Events
  (`wiki.page.updated`, `chat.room.message.created`); Today, Network and Quest are read by the due-based
  `server/pulse/sources.js` (next run per source in `pulse_source_runs`), never while a feed request is answered.
  - `GET /api/v1/feed` keeps its shape and gains `text` (the first 280 characters), the first `picture_url` of
    Community's own posts and pastes, Community's own `counts` (views, likes, comments), and the `site=`, `q=` and
    `following=1` filters (the signed-in person's Network follows).
  - `POST /api/v1/posts { text, pictures: [{ media_id, alt }] }` posts up to four pictures (alt required), uploaded
    through Media, and the post is in the Feed at once. Attachments remember the alt text.
  - `migrations/0024_feed_wide.sql` (expand): `pulse_items.text`, `attachments.alt`, `pulse_source_runs` and
    `pulse_quest_people`.
  - Contracts: `community.feed-item@1`; SDK: `ov.community.feed()` and `ov.community.posts.create()` (their own PRs).

- **The forum moved from `/s` to `/forum`** (design 2026-11-07, section 13 "URLs people already know"). The board
  is `/forum`, a space `/forum/<space>`, and a thread `/forum/<space>/<thread>` (the `/t/` segment is gone);
  `/forum/new` and `/forum/discuss` replace `/s/new-space` and `/s/discuss`. Every old `/s` address answers a
  permanent redirect with the query kept — 301 for reads, 308 for form posts, so `/s/<space>/t/<slug>` becomes
  `/forum/<space>/<slug>` without losing a method or body.
  - A thread slug may never be one of a space's own sub-route words (`new`, `log`, `settings`, `feed.xml`,
    `moderators`, `chat-room`, `members`, `about`, `search`, `rules`, `wiki`, `edit`, `discuss`): a title that would
    make one takes `-2`. A space may not take `new`, `discuss`, `feed.xml`, `search` or `about`.
  - Sitemap, robots (`/forum/*/new`), IndexNow pings, feeds, `llms.txt`, canonical links and BreadcrumbList
    (`Forum › Space › Thread`), Search documents, Pulse items, `community.thread/post.created` URLs and the Discord
    relay all use `/forum`.

- **Locked pastes** (Locker design 2026-11-06, "The pilot, spelled out: locked pastes"). A new text paste can be
  locked: the browser seals it, Community stores the envelope and never sees the content key.
  - `POST /api/pastes` takes `locked: true` and `envelope: <base64 locker.envelope.v1>` **instead of** `content`; a
    request with both, a bad envelope, a public audience, a burn-after-reading lock or a screenshot is refused.
    `migrations/0020_locked_pastes.sql` adds `locked`, `lock_kind`, `envelope` and `title_shown` to `pastes`
    (expand-only), and openvibe-sdk/share's own columns since 0.85.0 (`shares.lock`, the members' `key_slot`, the
    transfers' `key_slot`, `reseal_nonce_base`).
  - The title lives inside the envelope unless the owner ticks "Show the title to people who can open it". A people
    lock names its people with a key slot each, checked against Network's key directory; a password or link lock is
    opened from the link. The audience follows the lock (`people` or `link`), and a locked paste is never public: no
    list, feed, sitemap, `llms.txt`, Search document, JSON-LD or related list ever has it.
  - The page opens the envelope with `OVLocker.open` (`/shared/ov-locker.js`) and shows the plaintext there; raw and
    download serve the bytes as `application/octet-stream`, named `<slug>.ovlk`. No highlight, summary, preview or AI
    pass. Comments stay open and say they are not locked. Copy, Share, Delete remain; Fork, edit and burn are refused.
  - Removing somebody from a people lock re-seals the content under a fresh key (`onReseal` stores the bytes in the
    same transaction, before the member goes).
  - `docs/locked-pastes.md` at `/docs/locked-pastes`, linked from `llms.txt`, with the document format and the agent
    path (`openvibe-sdk/locker`).
  - `openvibe-sdk` v0.89.0 and `openvibe-shared` v4.116.1 (the share sheet’s Locked part, `OVLocker.seal`, and a transfer’s key slot).
  - After Opus's review: while Lock it is on, /new's Visibility column becomes one read-only line naming the lock's
    audience ("For the people on the list", "Anyone with the password", "Anyone with the link") and comes back when it
    is off; the locked page's primary action is the card's own (unlock, password, link key), its file is one quiet
    "Download the locked file (.ovlk)" line under the card with the hint that it opens only with the key, and its meta
    line keeps the author, date, views, locked and audience chips but no language or line count.

- The screenshot move script (2026-11-06) no longer reads a 404 from Media's community tenant as "already gone": for a
  `legacy:live:paste:<slug>` object it keeps `previous_media_ref` and retires the object through Media's internal legacy-paste
  route. `--apply` pages with an id cursor and reaches every paste in one run, `--retire-ids <file>` retires named objects
  whose paste record was lost (one Media id per line), and the dry run prints the moves, retires and refusals it would make.
- The screenshot move script also retires an old Community v1 file object (`legacy:community:file:<key>`, app
  `community`, kind `file`) through Media's internal legacy route when DELETE answers 409
  `media.object.legacy_managed`. Before retiring it, the script reads Community's own tables (pastes, posts,
  attachments, submissions) and leaves the object in place when any other row still references the Media id, keeping
  `previous_media_ref` for a later retry; the summary counts those as `referenced` and names the tables. Test:
  `test/move-screenshots.test.js`.
- Review follow-up: a failed review keeps the owner's requested visibility/audience/NSFW choice in
  `review_requested_*`; `server/pastes/review-retry.js` retries pending reviews with backoff and restores the
  visibility and share audience when Vision later says fine. Migration `0018_paste_review_retry.sql`, Contracts
  v0.294.0.
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
- Unsafe-image review (VIS-6): image pastes are reviewed by OpenVibe.Vision (`OV_VISION_URL`) before they are
  returned. `fine` keeps its visibility, `sex_acts` becomes private and NSFW, `minor_sexual` becomes private,
  NSFW and quarantined with the operator report id. A Vision outage makes the paste private and pending; the
  owner cannot re-publish a reviewed paste. A hidden review also closes the paste's share row and removes its
  members, so the sharing gate cannot reopen it. Migration `0017_paste_reviews.sql`, `server/pastes/review.js`,
  tests `test/paste-review.test.js`.

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
