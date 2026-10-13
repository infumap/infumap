# Persistent chats (proposal)

Status: design, not started. Discussed 2026-10-11, revised 2026-10-13.

Today chat transcripts are held in memory only and are lost when the chat is cleared or the page reloads.
"Materialize" writes a `.md` text item holding only the visible user and assistant text, without tool calls,
reasoning or the turn activity dropdown ([chat.ts](../web/src/items/chat.ts), `queryChatMarkdown`).

The proposal: each chat is a query item in the Queries page, with its transcript in a file from the first turn.
Chats can be continued there, are persisted into the item tree by dragging them out, and can be dragged back in to
continue them.

## Live chats and persisted chats

- **Live chat.** A query item under the Queries page, plus a transcript file `chats/{query_item_id}.chat` in the
  user's data directory, next to the files and indexes. The file is created on the chat's first turn and appended
  to on each turn. The query item is an ordinary DB item, so the Queries page's list shows, selects, orders and
  deletes live chats with the existing list page machinery. Only live chats can be continued.
- **Persisted chat.** Dragging a live chat out of the Queries page into the item tree **persists** it: a `.chat`
  text item is created at the drop location, and the query item and its transcript file are removed. The text
  item's content is immutable, like any other text item, so a persisted chat is read-only.
- **Continuing a persisted chat.** Dragging a `.chat` item into the Queries page **moves** it back: a new live
  chat is created from its content and the `.chat` item goes to the trash. A "Continue" button in the text item
  toolbar **copies** it: a new live chat is created and the item stays where it is. Either way the live chat gets a
  new uid (see below). A persisted chat is never continued in place.

Only query items under the Queries page have transcripts. Query items are only created there
(`ensureQueryItemUnderQueries` in [navigation.ts](../web/src/layout/navigation.ts)), and the server already keeps
them there (see "The server guards chat moves"), so a query item elsewhere can only come from data older than that
guard. It gets no transcript, and the client no longer has an in-memory chat for it: a chat there fails with "The chat
was not found".

### Why transcripts are outside the object store

Text item content is immutable after creation and may be stored in S3, in two S3 stores, or in S3 and locally.
Rewriting a blob on every turn would mean writes to every store without atomicity across them. Everything derived
from content would also need invalidating, because it is keyed by item id: fragment artifacts, the content index,
and the search startup check stamps ([search_reconciliation.rs](../infumap/src/ai/search_reconciliation.rs)).
Keeping the mutable phase in a local file and freezing it on persist avoids all of this. The query item record is
small and its fields change rarely, so it can live in the item DB.

### Why moving back to the Queries page changes the uid

Blobs are stored under `{user_id}_{item_id}` ([object/mod.rs](../infumap/src/storage/object/mod.rs)). If a
persisted chat were moved back, continued, and persisted again with the same uid, its content would change under
the same id. File responses are cached by the browser (`private, max-age=…` in
[files.rs](../infumap/src/web/routes/files.rs)), and the client and server also cache text and derived artifacts
by item id. The rule is: **content under a uid never changes**.

So moving a chat back creates a new query item with a new uid and sends the `.chat` item to the trash; the old
uid's content is deleted with the item, never rewritten. Links to the `.chat` item break, and its attachments go
to the trash with it. Trashing rather than deleting keeps the move reversible. Persisting the chat again gives it
another new uid.

Continuing in place (replacing a text item's content) would need replaceable text item content, a general feature
that chat should not be the reason for.

### Persisting

A query item cannot become a file item under the same uid, so the `.chat` item gets a new uid. Dropping a chat
query item outside the Queries page calls a persist endpoint instead of the ordinary move. Moving it to the trash
is a delete, not a persist.

The request carries the same placement fields the client would send for an ordinary move to the drop location
(parent, relationship, ordering, and spatial position and width where the target needs them). The endpoint takes
the per-chat lock, rejects a chat with a running turn, and then:

1. writes the transcript's bytes under the new uid with `object::put`, which fails unless every configured store
   succeeded, as when adding any data item ([item_ops.rs](../infumap/src/web/routes/command/item_ops.rs))
2. commits the `.chat` item at the drop location, with a dedicated MIME type such as `application/x-infumap-chat`
3. deletes the query item
4. removes the transcript file

It returns the new item, and the client replaces the query item with it.

The MIME type is set explicitly, not detected. Detection from the bytes would give `text/plain` for JSONL
(`detect_data_item_mime_type` in [item_ops.rs](../infumap/src/web/routes/command/item_ops.rs)), and the search
pipeline indexes `text/plain` ([search_processing.rs](../infumap/src/ai/search_processing.rs)). The dedicated type
is ignored by indexing until chat indexing is added, and is how the client recognizes a `.chat` item.

**The server guards chat moves.** A guard already exists, stricter than needed: every query item under the
Queries page is sent to the client with `capabilities: { move: false, resize: false }`, and `handle_update_item`
rejects any change to its parent, relationship or ordering (`is_queries_page_query_item` and
`item_move_fields_changed_to_disallowed_layout` in [command/mod.rs](../infumap/src/web/routes/command/mod.rs);
[item_ops.rs](../infumap/src/web/routes/command/item_ops.rs)). Flag and title changes are allowed. Keep it for
generic updates, so no path other than persist can take a chat out of the page, with these exceptions (step 7):

- An unpinned chat query item is sent with `capabilities: { resize: false }`, so it can be dragged. The pinned one
  stays `move: false` and fixed.
- The server accepts moving an unpinned chat query item into the trash, which is how it is deleted, unless a turn is
  running. It accepts moving a query item from the trash back to the Queries page, unpinned, and rejects moving it
  from the trash anywhere else.
- The client rejects a drop of a chat anywhere but the trash, and of a trashed query item anywhere but the Queries
  page, with a message, before anything is sent (`chatDropRejectionMessage` in
  [mouse_up.ts](../web/src/input/mouse_up.ts)). In step 9, a drop outside the Queries page calls persist instead.

A failure or crash before step 2 leaves the live chat untouched and an orphan blob, as a failed upload does today.
A crash between steps 2 and 3 leaves a persisted copy and the live chat, both valid; the user deletes one. A crash
between steps 3 and 4 leaves an orphan transcript file, which startup cleanup removes (see "Deleting"). No move
journal is needed.

## The server owns the transcript

Today the client keeps the model's message list in the query runtime and sends all of it on every request
(`submitQueryChatMessage` in [chat.ts](../web/src/items/chat.ts)). If the server only appended what the client
sent, there would be two copies of the transcript that can disagree: after a reload, with two tabs on the same
chat, or after a cancelled turn.

Instead the file is the authoritative transcript. A chat request carries the query item id, a request id, the
expected transcript revision and the new user text, not the message list. The server checks that the id is a
query item of the session user under their Queries page, reads the history from the file, runs the turn, and
appends to the file. Requests without a query item id stay as they are now and write nothing.

- **A disconnect still cancels the turn.** The server cancels the run when the client disconnects
  ([chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs), `disconnect.closed()`), and this stays. A
  reload or closed tab during a turn records it as cancelled; there is no reattaching to a running turn.
- **One turn at a time.** The server holds a per-chat lock for the length of a turn and rejects a second turn on
  the same chat while one is running. Persist and permanent delete take the same lock and also reject a running
  turn. A persisted or deleted chat cannot accept another turn.
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

- `header`: format version, the query item id it was created for, creation time. First line only. A persisted
  `.chat` item keeps the header unchanged; the id is informational and is not the item's id. Continuing a `.chat`
  item writes a fresh header with the new query item id, followed by the copied records.
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
is a composite, as in the chat window now. Selecting a live chat in the Queries page, including after a reload,
loads its transcript into the chat view the same way.

- **Markdown conversion.** Use the server's
  [markdown.rs](../infumap/src/web/routes/command/chat/markdown.rs) (`chat_response_items_json`). It already builds
  the chat window's items, so a reopened chat looks the same as it did when it ran. A load endpoint returns, per
  turn, the user text, the assistant items, outcome, error details and recorded activity, for live and persisted
  chats alike. For a live chat it also returns the transcript revision, whether a turn is running, the settings of
  the last turn, and the last context token count reported for it. Merging it with the client
  converter in [text-document.ts](../web/src/items/text-document.ts) is separate work and doesn't block this.
- **Unsuccessful turns.** A cancelled, failed or interrupted turn is shown as the user text followed by a one-line
  outcome note with any error details. Pending tool approvals from an ended turn must not remain actionable.
- **Missing transcript.** A query item whose transcript file is missing (for example after restoring the item DB
  from a backup) shows an empty, read-only chat with a "transcript not available" note.
- **Turn dropdown.** Keep activity as side data rather than adding a persistent composite property. The live chat
  view restores dropdowns after a reload. The current helpers in
  [query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts) depend on a query-backed page and anchor
  activity to assistant root items; reloaded turns map request ids to the generated turn roots. On `.chat` document
  pages, the first version shows text only. Dropdowns there need activity ownership generalized to document pages
  and anchors for unsuccessful turns, and are a later step; the data is already in the file. A turn composite
  copied out of the generated page (shift-drag) loses its trace, and that is acceptable.

## Listing live chats

The Queries page is a list page with manual ordering. Today it holds one query item pinned to the top
(`ensureQueryItemUnderQueries` in [navigation.ts](../web/src/layout/navigation.ts)), the Scopes page pinned to the
bottom (`default_scopes_page` in [routes/mod.rs](../infumap/src/web/routes/mod.rs)), and `.md` items that
Materialize creates in between (Materialize goes, see "Other details"). The server also adds two virtual,
read-only search status pages ("Search processing", "Search needs attention") to the page's children, pinned to the
bottom with the Scopes page. With each
chat a query item, the middle band is the chat history and no second list is needed. Pinning to the top and bottom
bands is generic list page behavior.

- **The pinned query item is the current chat.** It is where new searches and chats start. Its transcript file is
  created on its first chat turn.
- **New chat** (replacing Clear) is available when the current chat has a transcript. It unpins the current query
  item, which stays in the list as the newest history entry, and creates a new pinned query item. It is disabled
  while a turn is running. `ensureQueryItemUnderQueries` changes to find the pinned query item rather than the
  first one, and creates one if none is pinned.
- **History entries** are the unpinned query items, newest first. No reordering is needed, which matters because
  the server rejects ordering changes for these items: each new pinned query item is created at the beginning of the
  page's children, so once unpinned it already sorts before every older chat. Unpinning only changes flags.
  Selecting one shows its chat, which can be continued. Unpinned items are chat only; their search mode is hidden.
- **Restoring a chat** loads its transcript and puts the settings of its last turn (model selection,
  capabilities, scope, mode) into the query runtime, so continuing it does not silently switch to whatever was
  last used elsewhere. The context token display starts from the last reported count. Today it is estimated from the
  client-held message list ([chat.ts](../web/src/items/chat.ts), `estimateChatContextTokens`), which no longer
  exists; while drafting, add the estimate for the draft text to the last count.
- **Titles.** Query items have no title today (`SearchMeasurable` in
  [search-item.ts](../web/src/items/search-item.ts) has no `TitledMixin`), so add one on the client and server. On
  the server, `is_titled_item_type` in [infusdk item/mod.rs](../infusdk/src/item/mod.rs) excludes query items, and
  deserializing a titled type without a title is an error. Existing query items in the DB logs have no title, so a
  missing title must default to empty, as it already does for composites. The client's item parsing needs the same
  default. The list line item shows a hard-coded "Query" label
  ([Query_LineItem.tsx](../web/src/components/items/Query_LineItem.tsx)); show the title instead, falling back to
  "Query" when it is empty. On the first turn, the client sets the title from the first prompt (`titleFromPrompt` in
  [chat.ts](../web/src/items/chat.ts)) with an ordinary item update. Renaming is an ordinary title edit.
- **Entering the Queries page** (`navigateToQueries` in [navigation.ts](../web/src/layout/navigation.ts), and the
  initial load in [Main.tsx](../web/src/components/Main.tsx)) selects the item returned by
  `ensureQueryItemUnderQueries`, so a reload or navigation returns to the current chat, not to a history entry that
  was being viewed. That is acceptable to start with.
- **Generated titles.** When New chat or Continue unpins a chat, the client calls a server title endpoint for the
  unpinned query item, in the background. The history list is where titles matter, and three words of the first
  prompt are a poor label there. The server builds the title prompt from the visible user and final assistant text
  only, capped at a few thousand characters, so that the call is short even for long chats with large tool results.
  It updates the item title only if the title still equals the derived one (a server-side port of
  `titleFromPrompt`), so a manual rename always wins. It returns the new title for the client to apply. A failed
  call leaves the derived title. On a single local llama-server the call can still overlap with the next chat's
  first response; the capped input keeps that short.
- **Continuing a persisted chat.** Both the move (dragging a `.chat` item into the Queries page) and the copy (the
  Continue button) unpin the current chat, as New chat does, and create a new pinned query item whose transcript is
  a copy of the `.chat` item's content, with the item's title. The drop position is ignored: the continued chat
  always becomes the current chat. The move then sends the `.chat` item to the trash. A crash between creating the
  query item and trashing the `.chat` item leaves both, which is harmless.
- **Continue button.** Text items have their own toolbar
  ([Toolbar_Text.tsx](../web/src/components/toolbar/item/Toolbar_Text.tsx): item icon, open text file). Add
  Continue there, shown only for `.chat` items, so it works on a selected `.chat` item as well as on its document
  page. Check that `Toolbar_Text` is the toolbar shown while a text item's generated document page is open.
- **Deleting** a chat is an ordinary item delete. The transcript file stays while the query item is in the trash,
  so restoring it works, and is removed when the item is permanently deleted. At startup, after the item DB is
  loaded, transcript files whose query item does not exist are removed.

## Search indexing

Chats should be searchable. Do it for persisted chats first and defer live chat content.

- **Persisted chats are ordinary items.** They go through the normal fragment pipeline with a new `.chat`
  fragment source. The dedicated MIME type is set at persist; add it to content-kind classification, fragment
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

Live chat titles are title-indexed: title indexing covers any item with a non-empty title
(`item_title_fragment_for_item` in [title.rs](../infumap/src/ai/fragment/sources/title.rs)), and query items have
titles since step 2. That includes the model's `search` tool. The titles are a few words of the first prompt (or a
generated title), not answers, so this does not reintroduce the problem of a model citing its own earlier answers;
revisit if it turns out to be noise. Indexing live chat content is deferred: the content changes on every turn, so
its fragments would be regenerated repeatedly, and the Queries page list already covers finding a recent chat.

## Other details

- **Title of a persisted chat.** The `.chat` item takes the query item's title. If the title is still the derived
  one (for example, a chat persisted while still pinned, or after a failed title call), persisting runs the same
  title generation first, and falls back to the derived title if it fails. The title prompt moves from the client
  (`MATERIALIZED_QUERY_CHAT_TITLE_PROMPT` in [chat.ts](../web/src/items/chat.ts)) to the server.
- **Materialize goes.** Persisting a chat replaces materializing the whole chat as `.md`. Single-response
  Materialize is replaced by shift-dragging a turn composite out of the live chat view, which copies it into the
  tree as editable notes rather than a `.md` file. Today that is disabled: chat turn items are created with
  `copy: false` (`makeQueryChatItemReadOnly` in [chat.ts](../web/src/items/chat.ts)). Enabling copy on turn
  composites may need more than the flag, since they are client-only items built from generated items. With both
  buttons gone, the Queries page holds only chats.
- **Backups.** Backups contain the item DB logs only; item content is protected by the object store's own
  redundancy. Live chat query items are in backups, but their transcripts are in neither, even though they are
  primary data and may be long-lived. State this in the UI and docs: a live chat's transcript is lost with the
  server's data directory, and persisting it into the item tree puts its content in the object store. Surviving a
  reload does not mean a live chat is safe.
- **Encryption.** Live chat files are plaintext on disk, unlike blobs in the object store. Derived artifacts and
  indexes in the data directory are also plaintext, but live chats are primary data and not derived from an
  encrypted source. Decided: keep them plaintext and say so in the docs.
- **Retention.** Live chats accumulate in the Queries page. Deleting is an ordinary item delete; expiry may be
  added later.
- **Saved searches are out of scope.** Results come from the live DB and go stale, so only the query would be
  worth saving, and the existing materialize button for search results covers keeping results. A search history
  would be cheap later (unpinned query items that keep their search text), but nothing asks for it yet.

## Implementation steps

Each step can be committed on its own. After step 6, chats survive a reload. Steps 1 to 5 change nothing visible:
the chat route ignores requests without a query item id.

0. **Check the single-query-item assumption.** Done 2026-10-13, by reading code, not by running it. No blocker
   found:
   - Client state is keyed by query item id: the query runtime (`queryRuntimes` in
     [StoreProvider_PerItem.tsx](../web/src/store/StoreProvider_PerItem.tsx)), the streaming, request and delta
     maps in [chat.ts](../web/src/items/chat.ts), the activity UI maps in
     [query-chat-activity-ui.ts](../web/src/items/query-chat-activity-ui.ts), and the temporary chat page.
   - Selection, focus and keyboard code ([key.ts](../web/src/input/key.ts),
     [helper.ts](../web/src/components/items/helper.ts), [hit/index.ts](../web/src/input/hit/index.ts)) and
     arrangement ([page_list.ts](../web/src/layout/arrange/page_list.ts),
     [item.ts](../web/src/layout/arrange/item.ts)) test "is the selected item a query item", not "is it the query
     item". The query input's DOM id is derived from the visual element path, so it is unique per item.
   - The server has no single-query-item assumption; it only creates the default query item for new users.
   - The only assumption is `ensureQueryItemUnderQueries`, which pins the first query item it finds. It must find
     the pinned one instead (step 6). It is also what selects the current chat on entering the Queries page.
   - Found along the way, now in the design: the Scopes page is pinned to the bottom of the Queries page; the list
     line item has a hard-coded "Query" label; a server-side title on query items needs a default for existing
     records. (This step also said query items could be dragged out of the Queries page today. That was wrong: the
     server already makes them non-movable, found during step 2.)
   Still unverified until step 6 runs: selection and focus behavior with several query items in the list.
1. **Server chat store.** Read, append and delete for `user_{id}/chats/{query_item_id}.chat`, with per-chat
   locking, synced appends, revisions as `user` record counts, incomplete-tail repair, and interrupted turns
   derived on read. Tests: round-trip, an incomplete last line, rebuilding the message list after a cancelled turn.
   Done 2026-10-13: [transcript.rs](../infumap/src/web/routes/command/chat/transcript.rs).
2. **Query item titles.** Add query items to `is_titled_item_type` with a missing title defaulting to empty on the
   server and client, and show the title in `Query_LineItem`, falling back to "Query".
   Done 2026-10-13: [infusdk item/mod.rs](../infusdk/src/item/mod.rs),
   [search-item.ts](../web/src/items/search-item.ts), [titled-item.ts](../web/src/items/base/titled-item.ts),
   [Query_LineItem.tsx](../web/src/components/items/Query_LineItem.tsx). There is no rename UI for query items yet.
3. **Chat route writes transcripts.** The request takes a query item id, request id, expected revision and user
   text. Validate the query item, reject stale submissions before appending, create the file on the first turn,
   sync the `user` record, rebuild history from completed turns, and record the outcome on completion, error or
   disconnect.
   Done 2026-10-13: `start_live_chat_turn` and `LiveChatTurn` in
   [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs). A live chat stream starts with a `turn_accepted`
   event carrying the new revision; a stale request gets a single `transcript_conflict` event with the current
   revision. Checked end to end against a fake llama-server: completion, a stale revision, a backend error, a client
   disconnect mid-answer, and a second turn while one runs. Failed and cancelled turns were recorded but left out of
   the next turn's history.
4. **Activity collection.** Collect model rounds, tool calls and timing in `ChatProgressReporter` and write them
   into `turn` records, including partial rounds of unsuccessful turns.
   Done 2026-10-13: [activity.rs](../infumap/src/web/routes/command/chat/activity.rs) applies each event as
   `ChatProgressReporter` sends it, mirroring `reduceQueryChatStreamEvent` in [chat.ts](../web/src/items/chat.ts);
   the two must be kept in step. A turn's end records every round as complete, as the client shows them; a tool
   call that was running or awaiting approval keeps that status.
5. **Load endpoint for live chats.** Returns turns, revision, running state, last turn settings and last context
   token count for a query item.
   Done 2026-10-13: the `load-chat` command (`handle_load_chat` in
   [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs)), taking `{ queryItemId }`. Each turn has its
   request id, text, status (`running`, `completed`, `cancelled`, `error`, `interrupted`), times, error, and for a
   completed turn the assistant text and its items, built as for `final_items`; plus its rounds. A query item without
   a transcript loads as an empty chat at revision 0, so the missing-transcript case is not distinguished yet. Turn
   records now also store the last context token count of the turn (`contextTokens`), which the response returns
   from the latest ended turn.
6. **Client switchover.** These land together, because each alone leaves a broken state: the client sends the query
   item id and holds no message list; selecting a query item restores its transcript, settings and token count;
   New chat replaces Clear, unpinning the current query item and creating a new pinned one;
   `ensureQueryItemUnderQueries` finds the pinned item; search mode is hidden on unpinned items; the derived title
   is set on the first turn; revision conflicts refresh while preserving the draft.
   Done 2026-10-13: [chat.ts](../web/src/items/chat.ts) (`submitQueryChatMessage`, `ensureQueryChatLoaded`),
   [query.ts](../web/src/items/query.ts) (`startNewQueryChat`), [navigation.ts](../web/src/layout/navigation.ts),
   [Query.tsx](../web/src/components/items/Query.tsx). Details:
   - The query runtime keeps `revision` and a load state instead of a message list. The transcript is loaded when the
     query item is shown, and before the first turn is sent, so a submit never races an unfinished load.
   - Unsuccessful turns get a one-line outcome note, both when they happen and when loaded. A turn the server did not
     record (refused before `turn_accepted`, or stopped before it) is removed and its text given back as a draft.
   - Whole-chat and single-response Materialize still work: title generation sends the visible conversation without
     a query item id, so the server records nothing.
   - `ensureQueryItemUnderQueries` creates a new pinned query item if none is pinned. For older data whose single query
     item is unpinned and untitled, it pins that one instead.
   - Checked end to end with Playwright against a fake llama-server: first turn and derived title, restore after
     reload, a conflict from another tab (reloaded, draft kept), stopping mid-answer, New chat, opening and continuing
     an earlier chat, and a turn refused while another runs.
   - Fixed in step 7: New chat and the derived title changed the query item object they were given, but syncing
     replaces item objects (`upsertItemFromServerObject`), so after a sync the change went to a stale copy. New chat
     then sent the unpin but found the item still pinned locally, and created no new current chat. Both now change
     the object in `itemState`.
7. **Delete.** Let the server guard accept moving an unpinned chat query item into the trash. Remove the
   transcript on permanent deletion of its query item, and remove orphan transcripts at startup.
   Done 2026-10-13: the guard exceptions above; `delete_query_item_transcript` on `delete-item` and `empty-trash`,
   which keeps the file if a turn is still running; `remove_orphan_chat_transcripts` at startup, after items load,
   which also removes temporary files left by an interrupted create. Checked end to end: drag to the dock trash,
   refused drops (reorder in the list, drop on the chat area), restore, empty trash, refusal while a turn runs,
   and startup cleanup.
8. **Generated titles.** A server title endpoint over capped visible text, applied only to derived titles. Call it
   when New chat unpins a chat (and later Continue). Move the title prompt to the server.
   Done 2026-10-13: `POST /chat/title` with `{ queryItemId }` (`generate_live_chat_title` in
   [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs)), using the last turn's model selection. A title
   that is empty also counts as derived. The server applies the title itself, with a sync delta and title reindex,
   through `set_item_title_if_unchanged` in [item_ops.rs](../infumap/src/web/routes/command/item_ops.rs), which
   keeps a title set while the call ran. The client calls it after New chat's unpin and shows the result. The
   client's copy of the prompt stays until Materialize is removed (steps 9 and 12); Continue calls the endpoint in
   step 11. Checked end to end: New chat replaced "how do rust" with the generated title, and a chat renamed by hand
   kept its name with no model call. As with any `update-item`, a client whose copy of the item is stale (renamed in
   another tab and not yet synced) sends its old title with the unpin.
9. **Persist.** A server endpoint takes the query item id and the drop placement, generates a title if it is still
   the derived one, runs the persist sequence with the dedicated MIME type, and returns the new item. In
   `chatDropRejectionMessage`'s place, dropping an earlier chat outside the Queries page (other than into the trash)
   calls persist. Remove the whole-chat Materialize button.
   Done 2026-10-13: `POST /chat/persist` with `{ queryItemId, item }` (`persist_live_chat` in
   [chat/mod.rs](../infumap/src/web/routes/command/chat/mod.rs)). The client builds `item` with `TextFns` from the
   drop's placement, in `enqueueChatPersistIfDropped` in [mouse_up.ts](../web/src/input/mouse_up.ts), which replaces
   the moved chat's ordinary update. The server sets the id, the title (`<title>.chat`), the size and
   `application/x-infumap-chat`, and adds it through `add_item_for_user_with_mime_type`, then deletes the query item
   through `handle_delete_item` and removes the transcript. Only an earlier (unpinned) chat can be persisted. A refusal
   (running turn, current chat) rolls the move back and shows the server's reason. Whole-chat Materialize is removed.
   Until step 10, opening a `.chat` item does not render it as a chat. Checked end to end: a chat dragged onto a page
   in the dock became `Rust Lifetimes.chat` there, its file content equal to the transcript, the query item and
   transcript gone; a drag during a running turn was refused with its reason and rolled back.
   Fixed here: New chat now marks the unpinned chat movable locally (`capabilities: { resize: false }`), as the server
   does; before, it stayed undraggable until the page reloaded.
10. **`.chat` document page.** Read-only, text only. Extend the load endpoint to `.chat` items, reading the content
    from the object store.
11. **Continue and move back.** A server endpoint copies a `.chat` item into a new pinned query item with a fresh
    header, optionally trashing the original. Add the Continue button to `Toolbar_Text` for `.chat` items (copy),
    and handle dropping a `.chat` item onto the Queries page (move). Generate a title for the chat this unpins.
12. **Shift-drag copy of turns.** Enable copying turn composites out of the live chat view, then remove
    single-response Materialize. Independent of the other steps; can be done at any point.
13. **Search for persisted chats.** Chat content-kind recognition, visible-text fragments, reconciliation and
    source-kind support, excluded from the model's `search` tool by default.
14. **Docs.** Backup and durability of live chats, encryption, scope limitations, [chat-tools.md](chat-tools.md).
15. **Turn dropdowns on `.chat` pages** (later). Generalize activity ownership to document pages, with anchors for
    unsuccessful turns.

End-to-end checks on a throwaway test server, at least after steps 6, 9 and 11: reload mid-chat, two tabs, New
chat, persist, move back and Continue.
