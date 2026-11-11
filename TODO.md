
# Todo

- Large containers: load items progressively so containers with many items remain responsive without fetching
  and rendering all their contents at once.

- Container sync with a deleted container: `handle_sync_containers` fails the whole request if any subscribed
  container no longer exists or can't be accessed. So a client showing a page that was deleted elsewhere (e.g. its
  trash was emptied on another device) gets no sync updates for any container until it navigates away. Report such
  containers per subscription instead, and have the client remove them and leave any view of them, as reconciling a
  failed mutation does ([mod.rs](infumap/src/web/routes/command/mod.rs), [server.ts](web/src/server.ts)).

- Log-file locking: `KVStore` has no mechanism to prevent multiple processes opening the same log. Add exclusive
  locking so a second server or a local CLI command can't write concurrently to the same store
  ([kv_store.rs](infusdk/src/db/kv_store.rs); the server shutdown requirement is documented in [cli.md](docs/cli.md)).

- Runtime validation of item responses: many item `fromObject` functions accept `any` and copy fields without
  checking their types. Validate incoming fields, including flags, and report malformed responses before they
  reach layout or editing code ([note-item.ts](web/src/items/note-item.ts),
  [table-item.ts](web/src/items/table-item.ts), and the other item parsers).

- Recovered orphan placement during compaction: unreachable items are currently reparented directly to the home
  page at position `(0, 0)`. Put them in a dedicated recovery page so they can be inspected without piling up over
  existing content ([item_db.rs](infumap/src/storage/db/item_db.rs)).

- Text saves that fail as `not-found` or `client` aren't retried, and stay unsaved with sync paused until "Retry now".
  The network status dialog offers no way to discard them, except when the session has expired
  ([text_edit_session.ts](web/src/input/text_edit_session.ts)).

- `.chat` items of another user (on a public page) or on another server don't render as chats, since `load-chat` only
  reads a persisted chat for its owner ([chat/mod.rs](infumap/src/web/routes/command/chat/mod.rs)).

- Turn activity dropdowns on `.chat` pages: they show text only. The activity is already in the transcript; showing it
  needs activity ownership generalized to document pages, with anchors for unsuccessful turns
  ([query-chat-activity-ui.ts](web/src/items/query-chat-activity-ui.ts)).
