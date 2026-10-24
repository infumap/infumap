
# Todo

- Large containers: load items progressively so containers with many items remain responsive without fetching
  and rendering all their contents at once.

- Calendar ranges on links: a link's range is that of its target, and the server doesn't send link targets with a
  page's children. So that ranges starting before the visible window still show, each past link's target is fetched
  with its own request the first time the calendar is shown (`calendarRangeValues` in
  `web/src/layout/arrange/page_calendar.ts`). For calendars with many links, have the server include link targets
  with the children, or batch these fetches.

- Server-side hierarchy validation: moving an item into one of its descendants must be rejected for both child
  and attachment relationships. The client already checks for cycles, but `ItemDb::update` only rejects an item
  being its own parent and checks the immediate parent's type. Validate the full ancestor chain on the server
  ([item_db.rs](infumap/src/storage/db/item_db.rs), [move_target.ts](web/src/input/move_target.ts)).

- Container sync with a deleted container: `handle_sync_containers` fails the whole request if any subscribed
  container no longer exists or can't be accessed. So a client showing a page that was deleted elsewhere (e.g. its
  trash was emptied on another device) gets no sync updates for any container until it navigates away. Report such
  containers per subscription instead, and have the client remove them and leave any view of them, as reconciling a
  failed mutation does ([mod.rs](infumap/src/web/routes/command/mod.rs), [server.ts](web/src/server.ts)).

- Log-file locking: `KVStore` has no mechanism to prevent multiple processes opening the same log. Add exclusive
  locking so a second server or a local CLI command can't write concurrently to the same store
  ([kv_store.rs](infusdk/src/db/kv_store.rs); the server shutdown requirement is documented in [cli.md](docs/cli.md)).

- HTML drag-and-drop clippings: `handleStringTypeDataMaybe` currently logs dropped `text/html` to the console
  without creating an item. Implement clipping import at the drop target
  ([upload.ts](web/src/upload.ts)).

- Runtime validation of item responses: many item `fromObject` functions accept `any` and copy fields without
  checking their types. Validate incoming fields, including flags, and report malformed responses before they
  reach layout or editing code ([note-item.ts](web/src/items/note-item.ts),
  [table-item.ts](web/src/items/table-item.ts), and the other item parsers).

- Automatic log migration on startup: this is still documented as unfinished; startup opens logs at the current
  version, and upgrades require the manual `migrate` command. Define the supported upgrade paths before implementing
  automatic migration ([cli.md](docs/cli.md), [user_db.rs](infumap/src/storage/db/user_db.rs),
  [migrate.rs](infumap/src/cli/migrate.rs)).

- Public-page attachments inside composites: `authorize_item` handles composite members recursively, but the
  attachment branch doesn't follow a composite parent, so attachments of those members can be denied even when
  the member is readable. Complete that case while preserving the public-page boundary
  ([command/mod.rs](infumap/src/web/routes/command/mod.rs)).

- Recovered orphan placement during compaction: unreachable items are currently reparented directly to the home
  page at position `(0, 0)`. Put them in a dedicated recovery page so they can be inspected without piling up over
  existing content ([item_db.rs](infumap/src/storage/db/item_db.rs)).

- Review and finish [security.md](docs/security.md): it explicitly marks itself as rough and potentially flawed,
  contains an unfinished reverse-proxy sentence, and makes unsupported claims about obscurity, TOTP and password
  protection. Replace those with guidance grounded in the actual implementation and complete the deployment links.

- Text saves that fail as `not-found` or `client` aren't retried, and stay unsaved with sync paused until "Retry now".
  The network status dialog offers no way to discard them, except when the session has expired
  ([text_edit_session.ts](web/src/input/text_edit_session.ts)).

- Session expiry with another account: if a different account logs in in another tab, the session stays expired and
  the network status dialog doesn't say that another account is now logged in. Untested.

- `.chat` items of another user (on a public page) or on another server don't render as chats, since `load-chat` only
  reads a persisted chat for its owner ([chat/mod.rs](infumap/src/web/routes/command/chat/mod.rs)).

- Turn activity dropdowns on `.chat` pages: they show text only. The activity is already in the transcript; showing it
  needs activity ownership generalized to document pages, with anchors for unsuccessful turns
  ([query-chat-activity-ui.ts](web/src/items/query-chat-activity-ui.ts)).

- Chat transcript compaction: tool results stay whole for the rest of a chat, so a long chat eventually fails on a
  small-context model with "The conversation is too long for the model's context window." Compact the history when it
  nears the model's context size. A compacted result must say plainly that its content is gone, so that the model
  calls the tool again rather than reconstructing it ([transcript.rs](infumap/src/web/routes/command/chat/transcript.rs)).
