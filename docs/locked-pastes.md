# Locked pastes on OpenVibe Community (Locker)

A locked paste is sealed in the browser before it is sent. Community stores a `locker.envelope.v1` and never the text,
and never the content key: we cannot read it, index it, summarise it or recover it. This page is for people and agents;
the share sheet's **Locked** part is described in `openvibe-shared`'s `docs/share.md`.

## The three locks

| Lock | Who can open it | What the link carries |
|---|---|---|
| **For the people on the list** (`people`) | you and the people you name, each with their own Locker keys | the paste's address; no key |
| **With a password** (`password`) | anyone you give the password to | the paste's address; the password is not in it |
| **With the link** (`link`) | anyone with the whole link | the key, after `#k=` (browsers never send the `#` part to us) |

A locked paste is **never public**: no feeds, sitemap, `llms.txt`, search, previews, thumbnails, AI pass or fork. It does
not appear in anybody's lists but its owner's. Its comments are ordinary comments and are **not** locked (the page says
so). There is no recovery without the password or the locker keys.

## Inside the envelope

The plaintext is a JSON document, UTF-8:

```json
{ "v": 1, "type": "paste", "title": "Bridge notes", "content": "…", "language": "javascript" }
```

The title is inside it. If the owner ticks **Show the title to people who can open it**, the request also carries
`show_title: true` with the title, and Community stores that title outside the envelope (the page and its link preview
may then show it; the content still never leaves the envelope).

`GET /api/pastes/:slug` answers `locked: true`, `lock`, `title_shown` and `envelope_url`; `content` is always `null`.
`GET /p/:slug/raw` and `/p/:slug/download` serve the envelope exactly as uploaded, as `application/octet-stream`,
named `<slug>.ovlk`.

## Making one (a browser)

1. Seal the document with `OVLocker.seal(...)` (openvibe-shared's `ov-locker.js`), which keeps the content key in the
   tab.
2. `POST /api/pastes` with `locked: true` and `envelope: <base64>`, **instead of** `content`. Both at once is refused.
3. For `people`, send `members: [{ name, role, key_slot }]`, the slot taken from the sealed envelope's header for each
   person; the audience is `people`. For `password` and `link` the audience is `link`.
4. A `link` seal comes back with `linkKey`: put it in the address you share as `#k=<linkKey>`.

## Making one (an agent)

```js
const locker = require('openvibe-sdk/locker');
const doc = JSON.stringify({ v: 1, type: 'paste', title: 'Notes', content: 'the words', language: 'text' });
const sealed = await locker.seal(doc, { lock: 'link' });
const res = await fetch('https://openvibe.community/api/pastes', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ locked: true, envelope: Buffer.from(sealed.bytes).toString('base64'), audience: 'link' }),
});
const { slug } = await res.json();
const link = `https://openvibe.community/p/${slug}#k=${sealed.linkKey}`;
```

A **people** lock takes one public key per recipient, from Network's key directory, plus your own if you want to open it
later, and each member's `key_slot` from `sealed.header.slots.people`:

```js
const keysOf = async (name) => (await fetch(`https://openvibe.network/api/v1/people/@${name}/keys`,
    { headers: { authorization: `Bearer ${networkToken}` } })).json();          // { subject, ecdh_public, fingerprint }
const maticus = await keysOf('maticus');
const sealed = await locker.seal(doc, { lock: 'people', keys: [
    { subject: { type: 'user', id: mySubject }, publicKey: myEcdhPublic },
    { subject: maticus.subject, publicKey: maticus.ecdh_public },
] });
const slot = sealed.header.slots.people.find((s) => s.subject.id === maticus.subject.id);
```

A person without a Locker cannot be added: they make one the first time they open a locked item.

## Sharing a locked paste

- **Adding** someone wraps the content key for their key and saves the member with the slot
  (`PUT /api/v1/paste/:slug/share` with `key_slot`).
- **Removing** someone needs the content sealed again (a fresh key) for those who stay: send the new `envelope` with the
  member list, and the service stores it before the member goes (`onReseal`). The sheet says they keep what they already
  opened; they do.
- A transfer wraps the content key for the recipient; accepting removes the old owner's slot unless they kept access.

## Limits

- Locking needs a signed-in account, and only text pastes are locked today (screenshots stay on the media proxy).
- The envelope may be at most the paste limit (512 KB), which bounds the plaintext a little lower because of padding.
- A locked paste cannot burn after reading, be edited, be forked, or have its lock changed: the lock is set when the
  paste is made.
