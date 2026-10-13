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
  they are listed on the Queries page.
- **Persisted chat.** Dragging a live chat from the Queries page to somewhere in the item tree **moves** it: a
  `.chat` text item is created and the live file is removed. The text item's content is immutable, like any other
  text item, so a persisted chat is read-only.
- **Continuing a persisted chat.** Dragging a `.chat` item into the Queries page **copies** it: a new live chat
  is created from the item's content, with a new uid, and the item stays where it is. There is no move in this
  direction (see below). The `.chat` document page should also have a visible "Continue" action that does the
  same, since a drag is not discoverable.

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

### Keep the uid across the move

A live chat gets its uid when it is created. The move into the DB creates the text item with that same uid, so
index entries, links and an open document page stay valid. Only the place the id is found changes, from the
`chats` folder to the item DB.

Persisting takes the same per-chat lock as a turn and rejects a chat with a running turn. Under that lock, freeze
the live file, write its exact bytes to every configured object store, durably commit the item, then remove the
live file. A turn, rename or delete cannot change that snapshot while persistence is in progress. If persistence
partially fails, retain the live file and keep it frozen until the move is recovered; retries must use the same
bytes under the same uid.

Record the pending move durably, including the chat owner, uid and snapshot hash, before writing the blob. On
restart, recover pending moves before accepting mutations. Item-id existence alone is not proof of a completed
move: verify the matching owner and `.chat` item, the committed snapshot and successful storage of the blob in
all configured stores before deleting the live copy. A missing or mismatched blob leaves the live file intact
for recovery. Retrying a completed move returns the existing item rather than creating another one.

## The server owns the transcript

Today the client keeps the model's message list in the query runtime and sends all of it on every request
(`submitQueryChatMessage` in [chat.ts](../web/src/items/chat.ts)). If the server only appended what the client
sent, there would be two copies of the transcript that can disagree: after a reload during a turn, with two tabs
on the same chat, or after a cancelled turn.

Instead the file is the authoritative transcript. A chat request carries the chat's uid, a request id, the
expected transcript revision and the new user text, not the message list. The server reads the history from the
file, runs the turn, and appends to the file. Requests without a chat uid stay as they are now and write nothing.
Persistent-chat title generation is a separate server-side operation described below; it does not depend on a
client-held message list.

- **One turn at a time.** The server holds a per-chat lock for the length of a turn and rejects a second turn on
  the same chat while one is running. Persist and delete also reject a running turn. Rename and generated-title
  updates serialize through the same lock and recheck the chat's state before writing. A persisted, deleted or
  frozen chat cannot accept another turn or a late title update.
- **Retries.** The client creates the chat uid and request id before the first submission and retains them for
  retries. Under the lock, check for an existing request id before checking the expected revision. A retry with
  the same payload returns the recorded outcome, or reports that the original request is still running; it never
  appends another user message or runs the model again. Reusing a request id with a different payload is an error.
- **Stale tabs.** Load responses and turn acknowledgements include a transcript revision. Accept a new request
  only if its expected revision matches; otherwise reject it without appending. The client reloads the transcript,
  preserves the draft, and lets the user submit it against the updated conversation. Title changes do not advance
  the transcript revision. A load also reports whether a turn or persistence operation is in progress.
- **The server records the activity.** The turn dropdown's data (model rounds, tool calls, timing) is built on the
  client from stream events today. The server sends those events through `ChatProgressReporter`, so it collects the
  same data there and writes it when the turn ends. The file then matches what was shown, even if the tab is
  closed during the turn.
- **Cancelled and failed turns.** The user message is written when the turn starts. When the turn ends, an outcome
  is written: completed, cancelled (including a client disconnect), error or interrupted (recovered after a server
  crash). Sync the user record before starting inference and the terminal record before reporting completion.
  Today a cancelled user message stays in the transcript and the next request has two user messages in a row.
  Rebuilding the history from the file must
  give the same message list the client would have sent: only completed turns contribute assistant and tool
  messages. Partial rounds from unsuccessful turns are display-only activity. Disconnect handling must record
  the outcome even after the inference future is cancelled. If completion was already committed, a subsequent
  disconnect does not change it to cancelled; reloading returns the committed result.

## File format

The file must hold everything needed to continue the chat and to render it exactly as the chat window does:

- the model's full message list (`ChatMessage` in [server.ts](../web/src/server.ts)): user and assistant
  content, reasoning, tool calls and tool results
- per-turn activity for the turn dropdown: model rounds, tool calls, timing
- chat settings: model selection, capabilities, scope

Use JSONL, one record per message or event. It is text, easy to append to and easy to grep. A readable Markdown
transcript is not enough. It can't hold the above, and it can't be parsed back reliably, because separators like
`**You**` and `---` can appear in user text.

Records, each with a `type` field:

- `header`: format version, uid, creation time, initial title and its source (provisional for a new chat).
  First line only.
- `user`: request id, start time, expected transcript revision, the user's text, and the settings the turn ran
  with (model selection, capabilities, scope id, mode). Settings are per turn, not in the header, because they can
  change between turns. These fields also identify retries before a terminal record exists.
- `turn`: request id, the messages the turn added to the transcript (assistant and tool messages, as
  `ChatMessage`), the assistant's final text, the model rounds in the shape of `QueryChatActivityModelRound`
  ([StoreProvider_PerItem.tsx](../web/src/store/StoreProvider_PerItem.tsx)), start and end times, and the
  outcome, with error details when applicable. A cancelled or failed turn has the rounds collected so far, but
  no final assistant text or added transcript messages. An interrupted turn may have no recoverable activity.
- `title`: a new title and its source (generated or manual). The last accepted record wins. Generated updates
  are accepted only while the title is still provisional.

Store assistant turns as Markdown and build the items when the chat is shown. Don't store the item graph. Streamed
deltas are not stored individually: aggregate each round's reasoning, answer and tool calls, including partial
rounds on cancellation or error. Activity collected only in memory is lost on a server crash.

Each append is a complete newline-terminated JSON record, followed by a file sync. A write and a sync are not an
atomic transaction. A reader ignores an incomplete last line; before any further append, recovery must truncate
that tail to the last complete record under the chat lock and sync the repair. Do not silently skip malformed
records in the middle of a file. File creation and the persistence transition also need directory durability.

On restart, a `user` record without its matching `turn` record is recovered with an `interrupted` outcome before
the next turn is accepted. Keep the user message and do not rerun inference automatically. Transcript revisions
must be reconstructible from the durable user and terminal records, independently of title records.

## Rendering

Opening a `.chat` item works like opening a `.md` text item: a document page is generated on the fly. Each turn
is a composite, as in the chat window now. Loading a live chat into the chat window after a reload works the same
way.

- **Markdown conversion.** Use the server's
  [markdown.rs](../infumap/src/web/routes/command/chat/markdown.rs) (`chat_response_items_json`). It already builds
  the chat window's items, so a reopened chat looks the same as it did when it ran. A load endpoint returns, per
  turn, the user text, the assistant items, outcome, error details and recorded activity, for live and persisted
  chats alike, along with the transcript revision and current state. Merging it with the client converter in
  [text-document.ts](../web/src/items/text-document.ts) is separate work and doesn't block this.
- **Turn dropdown.** Keep activity as side data rather than adding a persistent composite property. The current
  helpers in [query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts) depend on a query-backed page
  and anchor activity to assistant root items. Generalize ownership to live chat views and `.chat` document
  pages, with request ids mapped to the generated turn roots. Cancelled, failed and interrupted turns need an
  explicit status composite as their anchor, even without assistant text. Show the outcome, error details and
  any partial activity; pending tool approvals from an ended turn must not remain actionable. A turn composite
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
  pages or activity records. This keeps search focused on the conversation, but does not prevent information
  crossing scopes: assistant answers can quote or summarize the same source content.
- **Keep chats out of the model's `search` tool by default.** Otherwise a model finds its own earlier answers,
  including made-up ones, and cites them as sources. This matters most for weak models.

Scopes constrain retrieval, not information already copied into a conversation. Continuing a chat under a
different scope retains its previous answers and completed tool results in the model history. A persisted chat's
searchable text follows the scope of that item, not the scopes of its original sources. Document this limitation;
excluding tool results from indexing is not an information-isolation guarantee.

### Live chat search (deferred)

Indexing live chats costs much more than indexing persisted ones, and the live chat list on the Queries page
already covers the most common case, finding a recent chat. Revisit this if that turns out not to be enough. What
it needs:

- **Live chats are not items.** The lexical index is keyed by `item_id`
  ([lexical_index.rs](../infumap/src/ai/lexical_index.rs)). Search results use the item tree for breadcrumbs, and
  scope filtering uses `allowed_item_ids`. Live chats need their own search result type, and scoped searches should
  exclude them.
- **Startup reconciliation would delete live chat entries.** It removes index entries whose ids aren't live items
  ([search_reconciliation.rs](../infumap/src/ai/search_reconciliation.rs), `orphan_ids`). Add the uids of files in
  the `chats` folder to the set of live ids it checks against.
- **Delay.** The index would be updated when a chat is appended to. With the 600 s batch window, new turns may not
  be searchable for up to 10 minutes.

## Listing live chats

The Queries page is a list page whose children are DB items: the pinned query item, plus `.md` items that
Materialize creates there. Live chats are not items, so listing them among those children means virtual entries in
list layout, hit testing and drag handling. That is the most invasive UI part of this design.

The cheaper option is a history list inside the query item's chat view. It shows live chats newest first, opens
one into the chat view, deletes one, and is where a drag out to the item tree starts. Recommended to start with.

## Other details

- **Title.** Write a provisional title derived from the first prompt when creating the file. Then start a
  separate server-side LLM title call concurrently with the first response, using only that prompt and with
  tools disabled. Neither call waits for the other. The title describes the request, not the eventual answer.
  Apply the result through the chat lock only if the chat is still live and its title is still provisional;
  otherwise discard it. A manual rename always takes precedence. A late result after persistence or deletion
  is discarded, and a failed title call leaves the provisional title without failing the turn. No client-held
  message list is needed for this operation.
- **Materialize.** Persisting a chat replaces materializing the whole chat as `.md`, so that button goes.
  Materializing a single assistant response as `.md` does something different and can stay.
- **Backups.** Product decision: live chats are excluded from backups, even though they are primary data and
  may be long-lived. State this in the UI and docs: users must persist a chat into the item tree for it to be
  included in backups. Surviving a reload does not mean a live chat is backed up.
- **Encryption.** Live chat files are plaintext on disk, unlike blobs in the object store. This appears to
  match the derived artifacts and indexes in the data directory (not checked in detail), but unlike those, live chats are primary
  data and not derived from an encrypted source. Say so in the docs, or encrypt them with the user's object key.
- **Retention.** Live chats accumulate. The history list needs a way to delete them, and possibly to expire them.

## Implementation steps

Each step can be committed on its own. After step 5, chats survive a reload.

1. **Server chat store.** Read, append, list and delete for `user_{id}/chats/{uid}.chat`, with coordinated mutation
   locking, durable appends, transcript revisions, incomplete-tail repair and recovery of interrupted turns.
   Tests: round-trip, an incomplete last line, rebuilding the message list after a cancelled turn.
2. **Chat route writes the file.** The request takes a chat uid, request id, expected revision and user text.
   Deduplicate retries and reject stale submissions before appending. Create the file on the first turn, sync
   the `user` record, rebuild history, collect activity in `ChatProgressReporter`, and durably record the outcome
   on completion, error or disconnect. Start the independent first-prompt title call concurrently with the response.
3. **Load, list, rename and delete endpoints.** Include revision and state in load responses, serialize mutations,
   and preserve manual titles against generated updates.
4. **Client sends the chat uid.** The query runtime holds the chat uid instead of the message list. Clearing the
   chat starts a new one. Track revision and request ids for submissions and retries. Refresh after revision
   conflicts while preserving the draft. Titles come from the server.
5. **Restore on load.** Opening the Queries page loads the most recent live chat into the chat view, including
   outcome/status anchors and activity for unsuccessful turns.
6. **History list** in the chat view: open, delete.
7. **Persist.** A server endpoint takes the chat uid, parent and ordering, creates the `.chat` text item with the
   same uid from a frozen snapshot, then removes the file after durable commit. Add the pending-move recovery and
   verified startup cleanup. Then add the drag from the history list.
8. **`.chat` document page.** Read-only, built from the load endpoint, with activity ownership generalized to
   document pages and turn dropdowns filled from the file.
9. **Continue.** A server endpoint copies a `.chat` item into a new live chat. Add the Continue button on the
   `.chat` page and the drag onto the Queries page.
10. **Remove whole-chat Materialize.**
11. **Search for persisted chats.** Chat MIME/content recognition, visible-text fragments, reconciliation and
    source-kind support, excluded from the model's `search` tool by default.
12. **Docs.** Explicit backup exclusion for live chats, encryption, scope limitations, [chat-tools.md](chat-tools.md).

## Searches

Searches could work the same way, but transient by default: a click saves one, outside the item DB unless it is
dragged into the tree.

The value is lower than for chats. Results come from the live DB and go stale, so what is worth saving is the
query (text, scope, arrangement), re-run when opened, not a snapshot of results. There is already a materialize
button for search results. It is not yet clear what a saved search file adds beyond a search history list. Don't
index saved searches.

## Open questions

- Should persisted chats ever be continued in place? That needs replaceable text item content, a general feature
  that chat should not be the reason for. If text items become editable for other reasons, revisit this.
- Live chats in the Queries list page itself, or in a history list in the chat view (recommended)? See "Listing
  live chats".
- Encrypt live chat files with the user's object key, or document that they are plaintext?
- What exactly does a saved search add over the existing materialize button?
