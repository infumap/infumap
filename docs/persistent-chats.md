# Persistent chats (proposal)

Status: design, not started. Discussed 2026-10-11, revised 2026-10-13.

Today chat transcripts are held in memory only and are lost when the chat is cleared or the page reloads.
"Materialize" writes a `.md` text item holding only the visible user and assistant text, without tool calls,
reasoning or the turn activity dropdown ([chat.ts](../web/src/items/chat.ts), `queryChatMarkdown`).

The proposal: chats are files from their first turn, can be continued on the Queries page, and are moved into the
item DB by dragging.

## Live chats and persisted chats

- **Live chat.** Created on the first turn of a chat, as a `.chat` file in a `chats` folder in the user's data
  directory, next to the files and indexes. It is appended to on each turn. Only live chats can be continued, and
  they are listed in the Queries page's chat view.
- **Persisted chat.** Dragging a live chat from the history list to somewhere in the item tree **moves** it: a
  `.chat` text item is created and the live file is removed. The text item's content is immutable, like any other
  text item, so a persisted chat is read-only.
- **Continuing a persisted chat.** A "Continue" action on the `.chat` document page **copies** it: a new live chat
  is created from the item's content, with a new uid, and the item stays where it is. There is no move in this
  direction (see below).

### Why live chats are outside the item DB

Text item content is immutable after creation and may be stored in S3, in two S3 stores, or in S3 and locally.
Rewriting a blob on every turn would mean writes to every store without atomicity across them. Everything derived
from content would also need invalidating, because it is keyed by item id: fragment artifacts, the content index,
and the search startup check stamps ([search_reconciliation.rs](../infumap/src/ai/search_reconciliation.rs)).
Keeping the mutable phase in a local file and freezing it on the move avoids all of this.

### Why moving back to the Queries page is not allowed

Blobs are stored under `{user_id}_{item_id}` ([object/mod.rs](../infumap/src/storage/object/mod.rs)). If a chat
were moved out, continued, and moved back in with the same uid, its content would change under the same id. File
responses are cached by the browser (`private, max-age=…` in [files.rs](../infumap/src/web/routes/files.rs)), and
the client and server also cache text and derived artifacts by item id. Moving out would also break links to the
item and leave nowhere for its attachments. The rule is: **content under a uid never changes**.

The cost is that continuing a persisted chat and persisting it again creates a second item. The user deletes the
old one if they want only one.

### The move

The client creates the chat uid. The server validates its format and rejects it on the first turn if it is already
an item id. The move into the DB creates the text item with that same uid, which makes the uid the move's
idempotency key: **a live chat whose uid exists as an item of the same user has been persisted**, and its file is
dead.

Persisting takes the per-chat lock, rejects a chat with a running turn, and follows the same order as adding any
data item ([item_ops.rs](../infumap/src/web/routes/command/item_ops.rs)): write the file's bytes with
`object::put`, which fails unless every configured store succeeded, then commit the item, then remove the file.

- A failure or crash before the commit leaves the live file in place and an orphan blob, as a failed upload does
  today. Nothing references the blob, so a later persist may overwrite it, even with different bytes after more
  turns.
- A crash after the commit leaves a dead file. Listing, loading and turn submission check for an item with the
  chat's uid and delete the file instead of using it. Retrying the persist returns the existing item.

The commit only happens after the put succeeded, so the item's existence is sufficient proof. No separate move
journal is needed.

## The server owns the transcript

Today the client keeps the model's message list in the query runtime and sends all of it on every request
(`submitQueryChatMessage` in [chat.ts](../web/src/items/chat.ts)). If the server only appended what the client
sent, there would be two copies of the transcript that can disagree: after a reload, with two tabs on the same
chat, or after a cancelled turn.

Instead the file is the authoritative transcript. A chat request carries the chat's uid, a request id, the
expected transcript revision and the new user text, not the message list. The server reads the history from the
file, runs the turn, and appends to the file. Requests without a chat uid stay as they are now and write nothing.

- **A disconnect still cancels the turn.** The server cancels the run when the client disconnects
  ([chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs), `disconnect.closed()`), and this stays. A
  reload or closed tab during a turn records it as cancelled; there is no reattaching to a running turn.
- **One turn at a time.** The server holds a per-chat lock for the length of a turn and rejects a second turn on
  the same chat while one is running. Persist and delete take the same lock and also reject a running turn. A
  persisted or deleted chat cannot accept another turn.
- **Stale tabs and retries.** The transcript revision is the number of `user` records in the file. Load responses
  and turn acknowledgements include it. A request is accepted only if its expected revision matches; otherwise it
  is rejected without appending, and the client reloads the transcript, preserves the draft, and lets the user
  submit it against the updated conversation. This also covers a retry after a dropped connection: if the
  original request was appended, the retry is stale. The request id is not used for deduplication. It correlates
  stream events and activity with the turn. A load also reports whether a turn is in progress, which matters for
  a second tab.
- **The server records the activity.** The turn dropdown's data (model rounds, tool calls, timing) is built on the
  client from stream events today. The server sends those events through `ChatProgressReporter`, so it collects the
  same data there and writes it when the turn ends. The file then matches what was shown, up to the point a turn
  was cancelled.
- **Cancelled and failed turns.** The user message is written and synced before inference starts. When the turn
  ends, an outcome is written and synced before completion is reported: completed, cancelled (including a client
  disconnect) or error. Disconnect handling must record the outcome even after the inference future is cancelled.
  If completion was already committed, a subsequent disconnect does not change it to cancelled. A `user` record
  without a `turn` record, while no turn for that chat is running, is shown as interrupted (server crash). This is
  derived on read; nothing is written at startup.
- **Only completed turns enter the model history.** Rebuilding the message list from the file includes the user
  message and the assistant and tool messages of completed turns only. An unsuccessful turn contributes nothing,
  not even its user message, which is still displayed. This changes current behavior: today a cancelled user
  message stays in the history and the next request has two user messages in a row, which some llama.cpp chat
  templates reject.

## File format

The file must hold everything needed to continue the chat and to render it as the chat window does:

- the model's full message list (`ChatMessage` in [server.ts](../web/src/server.ts)): user and assistant
  content, reasoning, tool calls and tool results
- per-turn activity for the turn dropdown: model rounds, tool calls, timing
- chat settings: model selection, capabilities, scope

Use JSONL, one record per message or event. It is text, easy to append to and easy to grep. A readable Markdown
transcript is not enough. It can't hold the above, and it can't be parsed back reliably, because separators like
`**You**` and `---` can appear in user text.

Records, each with a `type` field:

- `header`: format version, uid, creation time. First line only.
- `user`: request id, start time, the user's text, and the settings the turn ran with (model selection,
  capabilities, scope id, mode). Settings are per turn, not in the header, because they can change between turns.
- `turn`: request id, the messages the turn added to the transcript (assistant and tool messages, as
  `ChatMessage`), the model rounds in the shape of `QueryChatActivityModelRound`
  ([StoreProvider_PerItem.tsx](../web/src/store/StoreProvider_PerItem.tsx)), start and end times, and the
  outcome, with error details when applicable. The final assistant text is the last assistant message. A
  cancelled or failed turn has the rounds collected so far, but no added transcript messages.

Store assistant turns as Markdown and build the items when the chat is shown. Don't store the item graph. Streamed
deltas are not stored individually: aggregate each round's reasoning, answer and tool calls, including partial
rounds on cancellation or error. Activity collected only in memory is lost on a server crash.

Each append is a complete newline-terminated JSON record, followed by a file sync. A reader ignores an incomplete
last line; before the next append, truncate that tail to the last complete record under the chat lock. Do not
silently skip malformed records in the middle of a file.

## Rendering

Opening a `.chat` item works like opening a `.md` text item: a document page is generated on the fly. Each turn
is a composite, as in the chat window now. Loading a live chat into the chat window after a reload works the same
way.

- **Markdown conversion.** Use the server's
  [markdown.rs](../infumap/src/web/routes/command/chat/markdown.rs) (`chat_response_items_json`). It already builds
  the chat window's items, so a reopened chat looks the same as it did when it ran. A load endpoint returns, per
  turn, the user text, the assistant items, outcome, error details and recorded activity, for live and persisted
  chats alike, along with the transcript revision and whether a turn is running. Merging it with the client
  converter in [text-document.ts](../web/src/items/text-document.ts) is separate work and doesn't block this.
- **Unsuccessful turns.** A cancelled, failed or interrupted turn is shown as the user text followed by a one-line
  outcome note with any error details. Pending tool approvals from an ended turn must not remain actionable.
- **Turn dropdown.** Keep activity as side data rather than adding a persistent composite property. The live chat
  view restores dropdowns after a reload. The current helpers in
  [query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts) depend on a query-backed page and anchor
  activity to assistant root items; reloaded turns map request ids to the generated turn roots. On `.chat` document
  pages, the first version shows text only. Dropdowns there need activity ownership generalized to document pages
  and anchors for unsuccessful turns, and are a later step; the data is already in the file. A turn composite
  copied out of the generated page (shift-drag) loses its trace, and that is acceptable.

## Search indexing

Chats should be searchable. Do it for persisted chats first and defer live chats.

- **Persisted chats are ordinary items.** They go through the normal fragment pipeline with a new `.chat`
  fragment source. Add explicit chat format recognition to MIME detection, content-kind classification, fragment
  generation, source-kind allowlists and reconciliation. Reconciliation currently checks MIME types and expected
  fragment source kinds explicitly ([search_reconciliation.rs](../infumap/src/ai/search_reconciliation.rs)); it
  needs to recognize chat artifacts and their input fingerprints. Raw chat JSONL must never fall through to the
  ordinary plain-text indexer.
- **Index only the visible user and final assistant text.** Don't index reasoning, tool results, fetched web
  pages or activity records. This keeps search focused on the conversation.
- **Keep chats out of the model's `search` tool by default.** Otherwise a model finds its own earlier answers,
  including made-up ones, and cites them as sources. This matters most for weak models.

Scopes constrain retrieval, not information already copied into a conversation. Continuing a chat under a
different scope retains its previous answers and tool results in the model history, and a persisted chat's
searchable text follows the scope of that item, not the scopes of its original sources. Document this.

Live chat search is deferred: the live chat list already covers finding a recent chat. It would need its own
search result type (the lexical index, breadcrumbs and scope filtering all assume items), an exemption from
reconciliation's orphan cleanup, and exclusion from scoped searches.

## Listing live chats

The Queries page is a list page whose children are DB items: the pinned query item, plus `.md` items that
Materialize creates there. Live chats are not items, so listing them among those children would mean virtual
entries in list layout, hit testing and drag handling.

Instead, a history list inside the query item's chat view shows live chats newest first, labelled with a title
derived from the first prompt (`titleFromPrompt` in [chat.ts](../web/src/items/chat.ts)). It opens a chat into the
chat view, deletes one, and is where a drag out to the item tree starts. Live chats cannot be renamed; a persisted
chat is renamed like any item.

**Current chat.** The client remembers the current chat uid per query item in browser storage. On load, it
restores that chat if it is still live. Clearing the chat sets a fresh uid with no file yet, so a reload after
clearing shows an empty chat rather than the previous one. If nothing is remembered, the chat view starts empty and
the history list is the way back.

## Other details

- **Title.** Live chats have no stored title. When a chat is persisted, generate the item title with an LLM call
  over the transcript, as Materialize does today, falling back to the first-prompt title if the call fails.
- **Materialize.** Persisting a chat replaces materializing the whole chat as `.md`, so that button goes.
  Materializing a single assistant response as `.md` does something different and can stay.
- **Backups.** Backups contain the item DB logs only; item content is protected by the object store's own
  redundancy. Live chats are in neither, even though they are primary data and may be long-lived. State this in
  the UI and docs: a live chat is lost with the server's data directory, and persisting it into the item tree puts
  its content in the object store and its metadata in backups. Surviving a reload does not mean a live chat is safe.
- **Encryption.** Live chat files are plaintext on disk, unlike blobs in the object store. Derived artifacts and
  indexes in the data directory are also plaintext, but live chats are primary data and not derived from an
  encrypted source. Say so in the docs, or encrypt them with the user's object key.
- **Retention.** Live chats accumulate. The history list needs a way to delete them, and possibly to expire them.

## Implementation steps

Each step can be committed on its own. After step 5, chats survive a reload.

1. **Server chat store.** Read, append, list and delete for `user_{id}/chats/{uid}.chat`, with per-chat locking,
   synced appends, revisions as `user` record counts, incomplete-tail repair, and interrupted turns derived on read.
   Tests: round-trip, an incomplete last line, rebuilding the message list after a cancelled turn.
2. **Chat route writes the file.** The request takes a chat uid, request id, expected revision and user text.
   Validate the uid, reject stale submissions before appending, create the file on the first turn, sync the `user`
   record, rebuild history, collect activity in `ChatProgressReporter`, and record the outcome on completion, error
   or disconnect.
3. **Load, list and delete endpoints.** Include revision and running state in load responses.
4. **Client sends the chat uid.** The query runtime holds the chat uid instead of the message list, and remembers
   it per query item. Clearing the chat starts a new one. Refresh after revision conflicts while preserving the
   draft.
5. **Restore on load.** Opening the Queries page restores the remembered chat if it is still live, including
   outcome notes and turn dropdowns.
6. **History list** in the chat view: open, delete.
7. **Persist.** A server endpoint takes the chat uid, parent and ordering, puts the blob, commits the `.chat` item
   with the same uid and an LLM-generated title, then removes the file. Treat a live file whose uid is an item as
   dead. Then add the drag from the history list.
8. **`.chat` document page.** Read-only, built from the load endpoint, text only.
9. **Continue.** A server endpoint copies a `.chat` item into a new live chat. Add the Continue button on the
   `.chat` page.
10. **Remove whole-chat Materialize.**
11. **Search for persisted chats.** Chat MIME/content recognition, visible-text fragments, reconciliation and
    source-kind support, excluded from the model's `search` tool by default.
12. **Docs.** Backup and durability of live chats, encryption, scope limitations, [chat-tools.md](chat-tools.md).
13. **Turn dropdowns on `.chat` pages** (later). Generalize activity ownership to document pages, with anchors for
    unsuccessful turns.

## Open questions

- Should persisted chats ever be continued in place? That needs replaceable text item content, a general feature
  that chat should not be the reason for. If text items become editable for other reasons, revisit this.
- Encrypt live chat files with the user's object key, or document that they are plaintext?
- Should saved searches work the same way? Lower value than chats: results go stale, so what would be saved is the
  query rather than its results, and the existing materialize button may already cover it.
