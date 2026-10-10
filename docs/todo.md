
# Todo

- Calendar ranges on links: a link's range is that of its target, and the server doesn't send link targets with a
  page's children. So that ranges starting before the visible window still show, each past link's target is fetched
  with its own request the first time the calendar is shown (`calendarRangeValues` in
  `web/src/layout/arrange/page_calendar.ts`). For calendars with many links, have the server include link targets
  with the children, or batch these fetches.

- Server-side hierarchy validation: moving an item into one of its descendants must be rejected for both child
  and attachment relationships. The client already checks for cycles, but `ItemDb::update` only rejects an item
  being its own parent and checks the immediate parent's type. Validate the full ancestor chain on the server
  ([item_db.rs](../infumap/src/storage/db/item_db.rs), [move_target.ts](../web/src/input/move_target.ts)).

- Recovery after failed commands: `sendCommand` can force logout after a failed mutation to avoid inconsistent
  client state. Reconcile or roll back the affected state and show a useful error so a rejected operation doesn't
  end the session ([server.ts](../web/src/server.ts)).

- Log-file locking: `KVStore` has no mechanism to prevent multiple processes opening the same log. Add exclusive
  locking so a second server or a local CLI command can't write concurrently to the same store
  ([kv_store.rs](../infusdk/src/db/kv_store.rs); the server shutdown requirement is documented in [cli.md](cli.md)).

- HTML drag-and-drop clippings: `handleStringTypeDataMaybe` currently logs dropped `text/html` to the console
  without creating an item. Implement clipping import at the drop target
  ([upload.ts](../web/src/upload.ts)).

- Runtime validation of item responses: many item `fromObject` functions accept `any` and copy fields without
  checking their types. Validate incoming fields, including flags, and report malformed responses before they
  reach layout or editing code ([note-item.ts](../web/src/items/note-item.ts),
  [table-item.ts](../web/src/items/table-item.ts), and the other item parsers).

- Automatic log migration on startup: this is still documented as unfinished; startup opens logs at the current
  version, and upgrades require the manual `migrate` command. Define the supported upgrade paths before implementing
  automatic migration ([cli.md](cli.md), [user_db.rs](../infumap/src/storage/db/user_db.rs),
  [migrate.rs](../infumap/src/cli/migrate.rs)).

- Public-page attachments inside composites: `authorize_item` handles composite members recursively, but the
  attachment branch doesn't follow a composite parent, so attachments of those members can be denied even when
  the member is readable. Complete that case while preserving the public-page boundary
  ([command/mod.rs](../infumap/src/web/routes/command/mod.rs)).

- Recovered orphan placement during compaction: unreachable items are currently reparented directly to the home
  page at position `(0, 0)`. Put them in a dedicated recovery page so they can be inspected without piling up over
  existing content ([item_db.rs](../infumap/src/storage/db/item_db.rs)).

- Review and finish [security.md](security.md): it explicitly marks itself as rough and potentially flawed,
  contains an unfinished reverse-proxy sentence, and makes unsupported claims about obscurity, TOTP and password
  protection. Replace those with guidance grounded in the actual implementation and complete the deployment links.
