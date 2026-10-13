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

The move writes the item and its blob first and removes the live file after. If the server stops in between,
both exist. At startup, remove any live chat file whose uid is already an item.

## The server owns the transcript

Today the client keeps the model's message list in the query runtime and sends all of it on every request
(`submitQueryChatMessage` in [chat.ts](../web/src/items/chat.ts)). If the server only appended what the client
sent, there would be two copies of the transcript that can disagree: after a reload during a turn, with two tabs
on the same chat, or after a cancelled turn.

Instead the file is the only copy. A chat request carries the chat's uid and the new user text, not the message
list. The server reads the history from the file, runs the turn, and appends to the file. Requests without a chat
uid stay as they are now and write nothing. Title generation uses those.

- **One turn at a time.** The server holds a per-chat lock for the length of a turn and rejects a second turn on
  the same chat while one is running.
- **The server records the activity.** The turn dropdown's data (model rounds, tool calls, timing) is built on the
  client from stream events today. The server sends those events through `ChatProgressReporter`, so it collects the
  same data there and writes it when the turn ends. The file then matches what was shown, even if the tab is
  closed during the turn.
- **Cancelled and failed turns.** The user message is written when the turn starts. When the turn ends, an outcome
  is written: completed, cancelled (including a client disconnect) or error. Today a cancelled user message stays
  in the transcript and the next request has two user messages in a row. Rebuilding the history from the file must
  give the same message list the client would have sent.

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

- `header`: format version, uid, creation time, initial title. First line only.
- `user`: the user's text, and the settings the turn ran with (model selection, capabilities, scope id, mode).
  Settings are per turn, not in the header, because they can change between turns.
- `turn`: request id, the messages the turn added to the transcript (assistant and tool messages, as
  `ChatMessage`), the assistant's final text, the model rounds in the shape of `QueryChatActivityModelRound`
  ([StoreProvider_PerItem.tsx](../web/src/store/StoreProvider_PerItem.tsx)), start and end times, and the
  outcome. A cancelled or failed turn has an outcome and the rounds that were seen, but no assistant text.
- `title`: a new title. The last one wins.

Store assistant turns as Markdown and build the items when the chat is shown. Don't store the item graph. Streamed
deltas are not stored, only each round's final reasoning, answer and tool calls.

Each append is one line, written and synced in one write. A reader ignores an incomplete last line.

## Rendering

Opening a `.chat` item works like opening a `.md` text item: a document page is generated on the fly. Each turn
is a composite, as in the chat window now. Loading a live chat into the chat window after a reload works the same
way.

- **Markdown conversion.** Use the server's
  [markdown.rs](../infumap/src/web/routes/command/chat/markdown.rs) (`chat_response_items_json`). It already builds
  the chat window's items, so a reopened chat looks the same as it did when it ran. A load endpoint returns, per
  turn, the user text, the assistant items and the completed activity, for live and persisted chats alike. Merging
  it with the client converter in [text-document.ts](../web/src/items/text-document.ts) is separate work and
  doesn't block this.
- **Turn dropdown.** This probably doesn't need a change to the composite item type. Completed activity is
  already side data kept outside the composite: a map from request id to the turn's root items
  ([query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts)). The generated page can fill the same
  map from the file. Decided: a turn composite copied out of the generated page (shift-drag) loses its trace, and
  that is acceptable. A persistent composite property isn't needed.

## Search indexing

Chats should be searchable. Do it for persisted chats first and defer live chats.

- **Persisted chats are ordinary items.** They go through the normal fragment pipeline with a new `.chat`
  fragment source. Nothing in reconciliation changes.
- **Index only the visible user and assistant text.** Don't index tool results or fetched web pages. Tool results
  quote content read under the chat's scope. If they were indexed, a chat running under another scope could find
  that content.
- **Keep chats out of the model's `search` tool by default.** Otherwise a model finds its own earlier answers,
  including made-up ones, and cites them as sources. This matters most for weak models.

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

- **Title.** A file created on the first turn needs a title then. Use the first prompt, and add a `title` record
  when the generated title arrives instead of waiting for it.
- **Materialize.** Persisting a chat replaces materializing the whole chat as `.md`, so that button goes.
  Materializing a single assistant response as `.md` does something different and can stay.
- **Backups.** Backups don't include the `chats` folder. With move semantics it holds only chats that were never
  persisted, so leaving it out is defensible, but say so in the UI or docs.
- **Encryption.** Live chat files are plaintext on disk, unlike blobs in the object store. This appears to
  match the derived artifacts and indexes in the data directory (not checked in detail), but unlike those, live chats are primary
  data and not derived from an encrypted source. Say so in the docs, or encrypt them with the user's object key.
- **Retention.** Live chats accumulate. The history list needs a way to delete them, and possibly to expire them.

## Implementation steps

Each step can be committed on its own. After step 5, chats survive a reload.

1. **Server chat store.** Read, append, list and delete for `user_{id}/chats/{uid}.chat`, with the per-chat lock.
   Tests: round-trip, an incomplete last line, rebuilding the message list after a cancelled turn.
2. **Chat route writes the file.** The request takes a chat uid and the user text. The route creates the file on
   the first turn, writes the `user` record, rebuilds the history from the file, collects activity in
   `ChatProgressReporter`, and writes the `turn` record on completion, error or disconnect.
3. **Load, list, rename and delete endpoints.**
4. **Client sends the chat uid.** The query runtime holds the chat uid instead of the message list. Clearing the
   chat starts a new one. The generated title is saved with rename.
5. **Restore on load.** Opening the Queries page loads the most recent live chat into the chat view.
6. **History list** in the chat view: open, delete.
7. **Persist.** A server endpoint takes the chat uid, parent and ordering, creates the `.chat` text item with the
   same uid, then removes the file. Add the startup cleanup. Then add the drag from the history list.
8. **`.chat` document page.** Read-only, built from the load endpoint, with turn dropdowns filled from the file.
9. **Continue.** A server endpoint copies a `.chat` item into a new live chat. Add the Continue button on the
   `.chat` page and the drag onto the Queries page.
10. **Remove whole-chat Materialize.**
11. **Search for persisted chats.** The `.chat` fragment source, excluded from the model's `search` tool.
12. **Docs.** Backups, encryption, [chat-tools.md](chat-tools.md).

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
