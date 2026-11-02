# Email connector

Design direction from discussion, not yet implemented. Nothing is built; the next step is M1 (below).

## Goal

A mail archive with Infumap as the way into it. Not a mail client: the provider's client stays in use for live mail.

In priority order:

1. **An archive of all mail, owned outside the providers.** The non-negotiable part.
2. **Search across accounts,** later chat over it.
3. **Mail inside Infumap:** browse by month, read threads, link an email into a page like a bookmark.
4. **Remove old mail from the providers** without losing the ability to reply.

Scale: about 75k messages in Gmail, probably the same in Fastmail. Gmail first, Fastmail next, others later.

Not building a client (compose, send, drafts, HTML editing, contacts, mobile). Years of work, and always worse than the
provider's.

## Architecture

**A separate executable in `connectors/mail/`,** depending on `infusdk` (item types, `Uid`, KV store, web listener are
already there). `provider` was rejected as a folder name: it already means LLM endpoints (`ChatProvider`), and here
also means Gmail/Fastmail. `connectors/` means "a separate executable that presents an external data source to
Infumap". `tools/gpu/gateway` computes things for Infumap rather than presenting data, so it stays in `tools/`.

**Emails are not items in the main item database.** `ItemDb` holds every item in memory and replays a log at startup
([item_db.rs](infumap/src/storage/db/item_db.rs)). 150k messages plus attachments would be ~300k items in every
startup, backup, title index entry and chat scope, and would bring back the partial-loading problem (see Related).
An email becomes a real item only as a link, when dragged onto a page.

**The main server proxies to connectors; the browser never talks to them.**

- Connectors listen on localhost. No second hostname, TLS, CORS, WireGuard route or login.
- The main server authenticates the user and passes the user id to the connector with a shared secret. The connector
  trusts only the main server.
- A generic route (e.g. `/connector/<name>/…`) forwards `get-items` and file/attachment downloads. The main server
  knows nothing mail-specific.
- Search and chat federation become possible server-side: the main server already talks to the connector.
- Cost: the main server is in the data path (negligible on one Pi), plus new proxy/name-resolution code and a new link
  form.

The existing remote-instance path (direct browser fetch, remote session header, `RemoteLoadStatus.AuthRequired`, see
[load.ts](web/src/layout/load.ts) and `post` in [server.ts](web/src/server.ts)) stays for genuinely external Infumap
instances. Rule: external instances are addressed by URL, connectors by name.

## Links and names

Links to email are `<name>://<uid>`, e.g. `personal://<uid>`, never a host. A host in links would break every email
link on a domain change, on deployments without a stable hostname, and when a data directory is copied to a test
instance (links would point at production). Links between local items survive all of these because they hold only
ids; links to email should too.

- **The name identifies a mailbox (account), not an instance or a provider.** Not an instance, so an account can move
  between connector instances. Not a provider, because the archive outlives Gmail: `gmail-personal://` would be wrong
  forever after moving or deleting from Gmail. Use `personal://`, `work://`. The provider is a per-account sync source
  in connector config and can change.
- **Names are configured once, in the connector.** The main server config lists only connector instances (address +
  shared secret) and asks each at startup which names it serves. Two instances claiming one name is a startup error.
- **One instance serves multiple accounts and providers,** managed separately. Multiple instances are allowed by the
  design but not needed for v1.
- **Each account's store is a self-contained directory** (raw messages, its own SQLite, its own index), so moving an
  account between instances means moving its config entry and directory. Cross-account dedup is lost, but costs
  little: the same email from two providers has different raw bytes (`Received:`, `Delivered-To:`).
- **Name validation:** lowercase letters, digits, `-`. Reject real schemes (`http`, `https`, `mailto`, `file`, `data`,
  `javascript`, `blob`, `ws`, `wss`).
- **Fix prefix checks in the client:** four places treat any `linkTo` starting with `http` as remote
  ([load.ts](web/src/layout/load.ts) twice, [arrange/util.ts](web/src/layout/arrange/util.ts),
  [ItemCandidates.tsx](web/src/components/library/ItemCandidates.tsx)). A name like `httpmail` would be misrouted.
  Parse the scheme instead.
- **Renames break links,** like a hostname change. Old names as aliases in connector config is cheap insurance; add
  when needed.
- **Later connector types share the namespace,** so name with that in mind (`personal`, `personal-cal`). Alternative
  considered: `mail://personal/<uid>` (type as scheme, account as host): never collides, longer links. Flat form chosen,
  judgment call.
- Rejected: bare id links, with the main server asking every connector about unknown ids. Every dangling id fans out,
  and ownership is ambiguous.

## Storage

- **Message id = first 128 bits of SHA-256 of the raw bytes,** as a `Uid` (32 hex). Links point at it, so it must
  never change. Message-ID headers are missing or duplicated sometimes; they are hints for threading and dedup only.
- **Raw bytes stored exactly as received** as `.eml`, never re-encoded. Standard format so the archive is never locked
  into Infumap. Encrypted object store under its own key prefix (e.g. `mail/<sha256>`), covered by backups.
- **Metadata in SQLite:** id, provider ids (separate per-account mapping table: `X-GM-MSGID`, later JMAP ids), thread
  id, date, sender, recipients, subject, labels, size, attachment names, bulk flag.
- **Labels are many-to-many metadata,** not folders.
- **Credentials stay server-side** (connector config for v1; one user on a Pi).
- New dependencies (`rusqlite`, an IMAP crate, `mail-parser`) must pass `deny.toml` and `check-crate-ages.py`.

## Ingestion

**Gmail: IMAP with an app password,** not the Gmail API. The API needs a Google Cloud OAuth app, `gmail.readonly` is
a restricted scope, and an unverified app in "testing" mode gets refresh tokens that expire after 7 days (fairly sure,
not verified recently). IMAP needs only 2-step verification, and mostly carries over to other providers.

- Sync only `[Gmail]/All Mail` (each message once; labels via `X-GM-LABELS`). Thread ids from `X-GM-THRID`.
- Resumable by UID, handle `UIDVALIDITY`. Poll every few minutes; no IDLE in v1.
- Gmail limits IMAP downloads to about 2.5 GB/day (from memory, verify). A 15 GB account takes about a week, so
  resumability is required from the start. Fallback: seed from a Takeout mbox, whose headers carry thread id and
  labels.

**Fastmail: JMAP,** not IMAP: native protocol, better thread ids and incremental sync. Keep the store schema
provider-neutral now; no provider abstraction until the second provider exists.

## Browsing

- **Months list messages, not threads.** A message's date never changes, so months are stable. Threads under the month
  of their latest message (Gmail-style) jump on every reply; under their first message, active old threads get buried.
- **A thread is a view opened from any of its messages.** Gmail gives thread ids; elsewhere use the JWZ algorithm on
  In-Reply-To/References, subject fallback only within a short window.
- **Dedup by Message-ID across accounts** for display (forwards, self-CCs, lists).
- **Bulk mail separately.** `List-Unsubscribe` or marked senders. Likely the majority of the 150k. Own section, decide
  separately whether to index. Improves search quality and month views more than anything else.
- 150k over ~15 years is ~800/month; with bulk removed, likely a few hundred rows per month table, which current tables
  handle.
- Plain-text viewer first. HTML needs a sandboxed iframe, sanitizer, and blocked remote images (tracking pixels).

## Attachments

- Kept inside the raw `.eml` (source of truth). Optionally also stored separately, deduplicated by hash.
- Filenames indexed from day one.
- Contents deferred. The PDF pipeline runs on the GPU host, not the Pi. PDFs with a text layer, plain text and docx are
  cheap and could come later.

## Index size (estimates, not measured)

Search is Tantivy only, no embeddings.

| | 150k messages |
|---|---|
| Raw mail incl. attachments | Unknown, dominated by attachments. Probably 5–30 GB total; check provider usage. |
| Extracted body text | ~0.5–1.5 GB (quoted replies inflate it) |
| Tantivy index | ~0.3–1.5 GB depending on stored fields |
| Per-item pipeline as-is | Text kept three times (local copy, `fragments.jsonl`, index): ~2–4 GB. Avoid; index from the mail store. |

A Pi 5 with an SSD is fine: small on disk, Tantivy memory-maps the index, indexing buffers ~50 MB, initial build minutes
to tens of minutes. Not on an SD card (write volume, durability). M1 produces the real numbers.

## Reply and deletion

- Delete from the provider only mail older than a window (e.g. 12 months), and only after each message is verified
  archived and backed up by hash. A manual step, not a background job: it can't be undone.
- **Restore to provider** for the rare reply to old mail: `IMAP APPEND` the original back (Gmail supports it). Message-ID
  and References survive, so the reply happens in the normal client with threading intact. No sending code.
- Accepted loss: after deletion, searching old mail from the provider's apps (phone included) is gone. Infumap search
  must work on mobile before deleting anything.

## Milestones

**M1: headless archiver.** Gmail IMAP sync of All Mail as a background task, raw store, SQLite metadata, CLI for status,
verify (re-hash every object) and export (mbox or Maildir). Done when: a full account is archived, counts match Gmail,
a second run does nothing, and an export opens in another mail client. Also yields size, body-text volume and bulk
share. Shows nothing in Infumap, deliberately: the archive is what has to be right. A Takeout import plus a plain list
would demo sooner but doesn't sync.

**M2: browsing, read-only.** Proxy route and `<name>://` links in the main server. Mail page, then years, then months,
then a message table (date, sender, subject, paperclip). Plain-text viewer, attachment download, thread view.

**M3: search.** Index headers and body text from the mail store. Hits in the existing search UI via the main server,
bulk excluded or marked.

**After:** linking an email into a page, Fastmail via JMAP, sandboxed HTML, attachment contents, chat (local models only
by default), provider retention and restore-to-provider.

**Not in v1:** sending, writing flags/labels back, HTML rendering, attachment contents, push sync, multi-account settings
UI, chat, deletion.

## Open questions

- How the main server's client represents connector items. Precedents: `clientOnly` items (chat pages) and `origin`
  items (remote containers). Not checked whether either fits; the first design task of M2. If neither does, M2 grows a
  lot.
- Read-only behaviour: the client may send updates (`remote.updateItem`, e.g. on resize). Unknown how it copes with
  refusals. Test early in M2.
- Exact link encoding in the client: a `linkTo` scheme or a named `origin`.
- How search federation merges connector hits with local ones, and how chat tools reach connectors.

## Risks

- **Chat sends email content to the model.** 15 years of mail holds other people's private information. Mail out of
  chat scope by default, or local models only.
- **HTML email rendering is real security work** (see Browsing).
- **OAuth tokens/app passwords for both providers live on the Pi.**
- **Deletion is irreversible** (see Reply and deletion).

## Related: partial container loading (deferred)

Raised by the home page bookmarks table getting slow. Useful in general (archiving moves the problem to the archive
page), but deferred in favour of email. Notes for when it comes back:

- Table rendering is already windowed (`buildTableWindowPlans` in [table.ts](web/src/layout/arrange/table.ts)). The cost
  is loading every child plus attachments, `applyContainerSnapshotFromServerObjects`, and `walkTabularRows` over all
  rows on every arrange. Measure first (synthetic 10k/50k-row table on the throwaway server): if per-arrange work
  dominates, caching fixes it far more cheaply than partial loading.
- Chat doesn't pay for big tables: a table on a page is one line (`table, N rows; columns: …`) in
  [container_fragments.rs](infumap/src/web/routes/command/chat/container_fragments.rs).
- Expensive: ~175 uses of `computed_children` in 45 client files assume the full list; container sync is
  snapshot-based and would delete unloaded children; sort order must be computed server-side identically; justified,
  spatial and document layouts don't window by order.
- If built: tables and list pages only, range fetch (sort spec, offset, limit) plus total count, "partial, N total"
  state, full-list operations fetch everything or are disabled, enabled above a child-count threshold (with a debug
  setting to force it everywhere, since otherwise the partial path is rarely exercised).
- Email avoids all of this by partitioning into month containers.
