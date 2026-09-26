# Discord relay

Community threads on Discord, and replies from Discord back as posts (roadmap WS-J tasks 5 and 6).
Everything is **off by default** and stays inert until the owner provides webhooks, a mapping and,
for the inbound half, a bot token.

## What it does

**Out** (`DISCORD_RELAY_ENABLED=true` plus a mapping):

- A new thread in a mapped **public** space is announced through the mapping's Discord webhook:
  "New thread in s/<space> by <name>", the title, an excerpt of the opening post and the link.
- Each reply to a thread that went to Discord follows it into the same channel (or into the
  Discord thread the mapping names), with who replied, an excerpt and the link to the post.
- Editing the opening post edits the thread's Discord message; editing a reply edits its message.
- Deleting a reply or a thread (by its author or a moderator), or making a thread or space
  members-only (VIP), deletes the Discord messages the relay had sent for it. Anything still
  waiting to be sent is skipped.
- Mentions are disabled on every message (`allowed_mentions.parse = []`); names and titles are
  escaped, so nothing relayed can ping anyone.

**In** (`DISCORD_RELAY_INBOUND=on`, `DISCORD_BOT_TOKEN`, and `inbound: true` on the mapping):

- A reply on Discord to a relayed message (Discord's Reply), or any message in a Discord thread
  started from a relayed message, becomes a post in that Community thread. Other messages in
  the channel are ignored.
- The post has origin `discord`, belongs to nobody on the site (no author subject) and shows the
  Discord display name with a "Discord" badge. It is never relayed back out.
- Edits on Discord edit the post (a new revision, `edited_by` `discord`); deletes on Discord
  delete it. Deleting the relay's own announcement on Discord only marks it gone; the thread stays.
- The thread must still be public, open (not locked) and not members-only; otherwise the
  message is refused and the reason is recorded for staff.
- Limits: `DISCORD_RELAY_INBOUND_PER_MINUTE` (6) messages a minute per Discord author per
  mapping, ten times that per mapping; `DISCORD_RELAY_INBOUND_MAX_CHARS` (4000) per message,
  longer text is cut. User, role and channel mentions, custom emoji and timestamps become plain
  text, `@everyone`/`@here` are defused, attachments are noted ("2 attachments on Discord") but
  never fetched. The rest is Markdown, which the forum's safe renderer shows (no raw HTML).

## How it works

| Piece | File | Notes |
| --- | --- | --- |
| Queue and sender | `server/relay/discord.js` | `relay_deliveries`: one row per dedupe key, actions `create`, `edit`, `delete`. Creates are sent with `?wait=true`, so Discord answers with the message and its id goes into the map. |
| External message map (task 5) | `relay_message_map` | Every Discord message the relay knows, both ways (`out`: a thread or reply it sent; `in`: a reply that came from Discord). Unique both ways: a Discord message is one local object, and a local object is one message per mapping. Edits and deletes on either side find their counterpart here. |
| Events worker (task 6) | `server/relay/events-worker.js` | Reads Community's own `community.thread.*` and `community.post.*` from OpenVibe.Events (`GET /api/v1/events`, capability `events.event.read`) and queues the creates. Its cursor (`relay_cursors`) moves in the same transaction as the deliveries a page queued; a replay queues nothing twice (dedupe keys), and nothing already in the map is sent twice. The first start begins at Events' head: older threads are never announced. |
| Gateway | `server/relay/discord-gateway.js` | Discord gateway v10 over Node 22's built-in WebSocket: IDENTIFY/RESUME, heartbeats (a missing ACK means a zombied connection: resume), RECONNECT, INVALID_SESSION, backoff. Intents `GUILD_MESSAGES` and `MESSAGE_CONTENT`. |
| Inbound | `server/relay/inbound.js` | `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_DELETE_BULK` for mapped channels only. |
| Staff API | `server/relay/api.js` | `/api/v1/relay/*`, below. |

When the Events worker is on, it is the one path for creates (the forum's own calls queue none).
Without `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET`, or with `DISCORD_RELAY_EVENTS=off`, the forum
queues creates itself, as the first relay did. Edits and deletes are always queued by the forum:
Contracts has no `community.thread`/`community.post` update or delete events yet.

**Loop prevention**, both halves: a thread or post with origin `discord` is never queued or sent
out (checked when queueing and again when sending); inbound ignores webhook messages (the
relay's own among them), bots, the bot itself and system messages, and never takes a message
that is already in the map.

**Retries and the dead letter**: network errors, timeouts, 5xx, 429 (its `retry_after`
honoured; the rest of that webhook's queue waits for the next pass) and an unset webhook variable
are retried with exponential backoff (`DISCORD_RELAY_BACKOFF_MS` · 2^(attempt−1), at most an hour)
up to `DISCORD_RELAY_MAX_ATTEMPTS`. Then the delivery is `failed`: the dead letter, kept with its
error, that staff retry or drop. Other 4xx fail at once. A delete that finds the message already
gone on Discord counts as delivered; an edit of a message that is gone is skipped.

**Secrets never live in the database**: a mapping names the environment variable holding the
webhook URL (`webhook_url_ref`), and only allow-listed names (`DISCORD_WEBHOOK_*`, or exactly
`DISCORD_RELAY_WEBHOOK_VARS`) can be mapped. No API response carries a webhook URL or the bot token.

## Staff API

Staff only: an admin/global_mod browser session, or a service holding `community.comment.moderate`.

| Route | What |
| --- | --- |
| `GET /api/v1/relay/status` | The queue by status (`failed` = dead letters), the Events worker (cursor, latest seq, lag, last error, last gap), the gateway (state, reconnects, last error) and open inbound failures |
| `GET /api/v1/relay/deliveries?status=&action=&limit=` | Deliveries; `status` pending, delivered, failed, dropped or skipped; `action` create, edit or delete |
| `POST /api/v1/relay/deliveries/:id/retry` | Queue it again now, with a fresh attempt budget |
| `POST /api/v1/relay/deliveries/:id/drop` | Give up on a pending or failed one (kept as `dropped`) |
| `GET /api/v1/relay/inbound?all=1` | Messages from Discord that did not become (or change) a post, and why: ids only, never the text |
| `POST /api/v1/relay/inbound/:id/dismiss` | Mark one seen |
| `GET /api/v1/relay/mappings` | Mappings: space, webhook variable (and whether it is set), Discord channel and thread ids, inbound |
| `POST /api/v1/relay/mappings` | `{ space, webhook_url_ref, enabled?, discord_channel_id?, discord_thread_id?, inbound? }` |
| `PUT /api/v1/relay/mappings/:id` | `{ enabled?, inbound?, discord_channel_id?, discord_thread_id? }` (`null` clears an id) |

`GET /api/ready` shows the same summary under `discord_relay` while the relay is on.

## Owner steps

1. **Webhook per channel** (outbound). In Discord: the channel's settings → Integrations →
   Webhooks → New Webhook, name it (for example "OpenVibe.Community"), Copy Webhook URL. You need
   Manage Webhooks on that channel to do this; the bot does not.
2. **The bot** (inbound only). At <https://discord.com/developers/applications>: New Application →
   Bot → Reset Token (this is `DISCORD_BOT_TOKEN`). Under Privileged Gateway Intents turn on
   **Message Content Intent** (Presence and Server Members stay off). Invite it: OAuth2 → URL
   Generator → scope `bot`, permissions **View Channels** and **Read Message History** (permission
   integer `66560`). It sends nothing itself (the webhook does), so leave Send Messages and Manage
   Webhooks off. It must be able to see each mapped channel, and threads in it (public threads only).
3. **Environment** in `/etc/openvibe/community.env` (0600):

   ```sh
   DISCORD_RELAY_ENABLED=true
   DISCORD_WEBHOOK_GENERAL=https://discord.com/api/webhooks/<id>/<token>   # one per channel, any DISCORD_WEBHOOK_* name
   # inbound
   DISCORD_RELAY_INBOUND=on
   DISCORD_BOT_TOKEN=<the bot token>
   ```

   `EVENTS_URL` and `OV_OAUTH_CLIENT_SECRET` are already set for the outbox, so the Events worker
   starts by itself. It needs the Network grant `community` → `events.event.read` on audience
   `openvibe.events` (in the Network's principal seed; check it is provisioned: a missing grant
   shows as a 403 in the worker's `last_error`).
   Then `sudo systemctl restart openvibe-community`. The boot log says
   `[Relay] Discord relay on: creates queued by the Events worker; events worker on; inbound on`.
4. **Map a space**, signed in as an admin on openvibe.community, from the browser console:

   ```js
   await (await fetch('/api/v1/relay/mappings', { method: 'POST', headers: { 'content-type': 'application/json' },
       body: JSON.stringify({ space: 'general', webhook_url_ref: 'DISCORD_WEBHOOK_GENERAL', inbound: true }) })).json();
   ```

   `discord_channel_id` is learned from Discord's answer to the first message; set it yourself
   (Discord: Settings → Advanced → Developer Mode, then right-click the channel → Copy Channel ID)
   if you want replies accepted before anything was sent. To post into one Discord thread instead
   of the channel, add `discord_thread_id`. Only public spaces are ever relayed.
5. **One production round trip**: start a thread in the mapped space → it appears on Discord;
   reply to it on Discord (Reply, or in a thread on the message) → the reply appears in the
   thread with a Discord badge; edit and delete it on Discord → the post follows; reply and edit
   on the site → Discord follows; delete the thread → its messages leave Discord. Watch
   `GET /api/v1/relay/status` (no dead letters, lag 0, gateway `ready`).

**Off again**: unset `DISCORD_RELAY_ENABLED` and restart (nothing is sent or read; the tables stay),
or per mapping `PUT /api/v1/relay/mappings/:id { "enabled": false }` (deletes still go out) or
`{ "inbound": false }`. Unset `DISCORD_RELAY_INBOUND` to close the gateway only.

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `DISCORD_RELAY_ENABLED` | off | The relay at all |
| `DISCORD_WEBHOOK_*` | — | Webhook URLs, named by mappings |
| `DISCORD_RELAY_WEBHOOK_VARS` | — | Exact variable names mappings may use (instead of `DISCORD_WEBHOOK_*`) |
| `DISCORD_RELAY_POLL_MS` / `DISCORD_RELAY_BACKOFF_MS` / `DISCORD_RELAY_MAX_ATTEMPTS` | `30000` / `30000` / `6` | Sender cadence, first retry delay, attempts before the dead letter |
| `DISCORD_RELAY_EVENTS` | on | `off` leaves creates to the forum instead of the Events worker |
| `DISCORD_RELAY_EVENTS_POLL_MS` | `5000` | How often the worker reads Events |
| `EVENTS_URL`, `OV_OAUTH_CLIENT_SECRET` | — | Events' address and Community's client secret (shared with the outbox) |
| `DISCORD_RELAY_INBOUND` | off | The gateway |
| `DISCORD_BOT_TOKEN` | — | The bot's token (inbound only) |
| `DISCORD_GATEWAY_URL` | `wss://gateway.discord.gg/?v=10&encoding=json` | The gateway |
| `DISCORD_RELAY_INBOUND_PER_MINUTE` | `6` | Messages a minute per Discord author per mapping (10× per mapping) |
| `DISCORD_RELAY_INBOUND_MAX_CHARS` | `4000` | Longest message taken in; longer is cut |

## Known limits

- Messages sent on Discord while Community is restarting (or the gateway is down longer than a
  resume allows) are not replayed: a new session starts from now.
- Private Discord threads, attachments (either way), reactions and Discord-side thread titles are
  not relayed.
- Threads created before the Events worker's first start are never announced, and replies go
  out only for threads that went out through that mapping.
- Edits made by the Roadmap sync (`docs/roadmap/public.json`) are not propagated to Discord.
- A retention gap in Events (the worker fell further behind than Events keeps) skips the creates
  in it; the gap is logged and shown in the status.
