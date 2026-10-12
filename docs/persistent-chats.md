# Persistent chats (proposal)

Status: idea, not started. Discussed 2026-10-11.

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

## File format

The file must hold everything needed to continue the chat and to render it exactly as the chat window does:

- the model's full message list (`ChatMessage` in [server.ts](../web/src/server.ts)): user and assistant
  content, reasoning, tool calls and tool results
- per-turn activity for the turn dropdown: model rounds, tool calls, timing
- chat settings: model selection, capabilities, scope

Use JSONL, one record per message or event. It is text, easy to append to and easy to grep. A readable Markdown
transcript is not enough. It can't hold the above, and it can't be parsed back reliably, because separators like
`**You**` and `---` can appear in user text.

Store assistant turns as Markdown and build the items when the chat is shown. Don't store the item graph.

## Rendering

Opening a `.chat` item works like opening a `.md` text item: a document page is generated on the fly. Each turn
is a composite, as in the chat window now.

- **Markdown conversion.** There are two Markdown to items converters today: server
  [markdown.rs](../infumap/src/web/routes/command/chat/markdown.rs) for chat replies and client
  [text-document.ts](../web/src/items/text-document.ts) for `.md` items. A `.chat` page should use one of them, so
  merging them is worth considering as part of this.
- **Turn dropdown.** This probably doesn't need a change to the composite item type. Completed activity is
  already side data kept outside the composite: a map from request id to the turn's root items
  ([query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts)). The generated page can fill the same
  map from the file. Decided: a turn composite copied out of the generated page (shift-drag) loses its trace, and
  that is acceptable. A persistent composite property isn't needed.

## Search indexing

Chats should be searchable, and the index updated when a chat is appended to. With the 600 s batch window, new
turns may not be searchable for up to 10 minutes.

- **Index only the visible user and assistant text.** Don't index tool results or fetched web pages. Tool results
  quote content read under the chat's scope. If they were indexed, a chat running under another scope could find
  that content.
- **Keep chats out of the model's `search` tool by default.** Otherwise a model finds its own earlier answers,
  including made-up ones, and cites them as sources. This matters most for weak models.
- **Live chats are not items.** The lexical index is keyed by `item_id`
  ([lexical_index.rs](../infumap/src/ai/lexical_index.rs)). Search results use the item tree for breadcrumbs, and
  scope filtering uses `allowed_item_ids`. Live chats need their own search result type, and scoped searches should
  exclude them.
- **Startup reconciliation would delete live chat entries.** It removes index entries whose ids aren't live items
  ([search_reconciliation.rs](../infumap/src/ai/search_reconciliation.rs), `orphan_ids`). Add the uids of files in
  the `chats` folder to the set of live ids it checks against.

## Other details

- **Title.** A file created on the first turn needs a title then. Use the first prompt, and rename the chat when
  the generated title arrives instead of waiting for it.
- **Backups.** Backups don't include the `chats` folder. With move semantics it holds only chats that were never
  persisted, so leaving it out is defensible, but say so in the UI or docs.
- **Retention.** Live chats accumulate. The Queries page needs a way to delete them, and possibly to expire them.

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
- Should the Queries page list live chats, and how: newest first, searchable, grouped by scope?
- What exactly does a saved search add over the existing materialize button?
