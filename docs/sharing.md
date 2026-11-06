# Sharing a paste

A paste has one audience, and its owner can give it away:

| Audience | Who can open it |
| --- | --- |
| `public` | Everyone; listed and in search. |
| `link` | Anyone with the link; not listed, not in search. |
| `people` | Only the owner and the OpenVibe accounts named on the list, signed in. |
| `private` | Only the owner. |

The service decides: every page, raw text, download, screenshot, JSON read, comment thread and
link preview asks the same access check (`canView`). A reader who is not on a `people` list gets a
404 and a gate ("Ask for access", or "Sign in"), never the title, the content, the screenshot or
the comments.

## Locked pastes

A text paste can also be **locked**: sealed in the browser before it is sent, so OpenVibe stores an
envelope and can never read the text ([`docs/locked-pastes.md`](locked-pastes.md)). A locked paste
is shared the same way, with two rules:

- It is **never public**: its audience is `people` (a people lock) or `link` (a password or link lock).
- Adding someone wraps the content key for their Locker; removing someone re-seals the content under
  a fresh key for those who stay (they keep what they already opened).

The share sheet shows a **Locked** part for one: what the lock means, each person's eight-word
fingerprint, and a warning when somebody's key changed.

## From the page

The paste page's **Share** button opens the shared sheet: Send it (the link, the phone's own share
sheet, a QR code, the embed) and Who can open it (the four audiences, @names, a transfer). Only the
owner sees and can change the second part.

## From an agent (bearer token)

Token: a Network user token, or a first-party service token acting as the person (`X-OV-Subject`).

Share one paste with exactly @maticus:

```sh
curl -X PUT "https://openvibe.community/api/v1/paste/<slug>/share" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"audience":"people","members":[{"name":"@maticus","role":"viewer"}]}'
```

Create a paste only the two of you can open, and offer it to @maticus in the same call:

```sh
curl -X POST "https://openvibe.community/api/pastes" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"LOOI bridge notes","content":"…","audience":"people",
       "members":["@maticus"],"transfer_to":"@maticus","keep_access":false}'
```

The answer carries `transfer.id` and `state: "pending"`. The recipient can open the paste to look,
then answers (the owner may cancel; an offer lapses after 7 days):

```sh
curl -X POST "https://openvibe.community/api/v1/paste/<slug>/share/transfer/accept" \
  -H "Authorization: Bearer $MATICUS_TOKEN" -H "Content-Type: application/json" \
  -d '{"transfer_id":"<uuid>"}'
```

Accepting makes the recipient the owner; with `keep_access: false` (the default) the old owner's
access ends then. `decline` changes nothing; `cancel` (the owner) withdraws the offer.

The same routes exist for any kind a page shares (`/api/v1/<kind>/<id>/share`), and
`GET /api/v1/shared-with-me` lists the pastes where you are a member or the recipient of a pending
transfer.

## Rules

- Names are exact OpenVibe accounts. An unknown name is refused; there is no username search.
- People and private pastes are never indexed, listed, put in a sitemap, embedded, or given a link
  preview with their title, description or picture.
- Burn-after-reading pastes cannot use `people`: a paste that ends on its first read cannot name
  several readers.
- A transfer is bound to the recipient's account, not to a link. Forwarding the notification gives
  nobody else anything.
