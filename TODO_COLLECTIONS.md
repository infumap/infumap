# Collections

Proposed design from discussion; not implemented. Collection pages replace the current scope pages. Search and chat
are limited by choosing a collection, or everything except a collection; there are no separate scope objects.
Existing scope pages are not migrated automatically; the user re-creates what they need by hand.

## Goal

Curate material in place, keep that selection under a name, and use it to limit search and LLM reads.

Example: a company research page contains documents, notes, tables and nested pages. While reviewing them, select
material into **Key sources**, **Risks** or **Background**. Include an industry report from elsewhere when useful.
Review the resulting collection or use it as a chat's retrieval scope without copying or moving the source material.

Importance is relative to a purpose. Membership in a named collection records that purpose; there is no separate
global "important" flag to keep synchronized with collection membership.

No expression language is needed. The first version is explicit curation, not a predicate evaluated against item
properties. Computed filters can later produce a selection for the same retrieval machinery.

## Concepts

### Collection

A collection is a page with a `Collection` page flag. The flag, not the title or location, identifies it. Clearing
the flag turns it back into an ordinary page.

Its direct link children are its members, in page order; new members are appended. Each member covers its target
and the target's descendants, including attachments. Other children (notes, subpages, anything that is not a link)
are annotations: they are not members and their subtrees are not covered. A collection with no members covers
nothing.

Because members are ordinary links, a collection can also be edited with existing tools: dragging or linking an
item into the collection page adds it, deleting the link removes it. Collection mode is the faster way to curate,
not the only one.

Adding a link adds its target, not the link's placement. Adding the same target from another appearance does not
create another membership entry.

The collection page can be opened, renamed, moved and linked from elsewhere. Its home organizes the collection, not
its membership. Moving an item outside the company's pages does not remove it from Key sources. Moving or renaming
the collection does not change its members or break references to it.

A collection says nothing about whether it is used to include or exclude material. That is decided each time it is
used, so the same collection can limit one chat and be hidden from another.

### Retrieval scope

Everything that remembers how retrieval is limited stores one of:

```
ScopeRef = everything | collection(<id>) | everythingExcept(<id>)
```

This covers search's remembered scope, query configurations and profiles, and chat transcripts.

- **everything** is the existing default search universe: the home page tree and query chats. It is not a new
  promise that every item on every connected host is searchable.
- **collection(C)** covers C's members and their descendants. An empty collection covers nothing, never everything.
- **everythingExcept(C)** covers everything minus C's coverage. Exclusion wins, including over an item that would
  otherwise be reachable another way. An empty collection excludes nothing.

The inversion belongs to the reference, not the collection. Putting it on the collection as a flag was considered
and rejected: the same collection could then not be used both ways, and flipping the flag would silently change
every profile and chat using it.

A missing collection, including a page whose Collection flag was cleared or that is in the trash, is an error. It
is never treated as an empty collection, and never as a reason to broaden retrieval.

Not expressible, deliberately:

- **C minus D.** Curate C without the unwanted items instead.
- **Several exclusions.** Use one collection whose members are all the subtrees to hide. Members are subtrees, so
  this needs no collection composition.

Items chosen in a chat (up to 32, see `MAX_SCOPE_ITEMS`) are unchanged. While a chat has any, they are used in
place of its scope reference.

## Replacing scope pages

Today a scope is a child page of the system Scopes page under Queries. Its link children are include roots, links
inside a child container titled "Exclude" are exclude roots, and a scope with no include links covers everything.
The title convention, the overloaded empty case and the problems they generate (`IgnoredContainer`,
`MultipleExcludeContainers`) all go away, along with named scopes as a concept.

Decided: no automatic migration. The user re-creates the collections they need by hand. An old scope page whose
links are all includes can become a collection just by setting its flag, since its link children are already its
members.

Remove the Scopes system page (`scopes_page_id`, `ensure_scopes_page`, `queries_subpage_name`, `scopesPageId` in
account responses and `listPageHiddenChildIds` in `page-item.ts`) and the page-based scope listing in `scope.rs`.
The existing Scopes page and its contents are user data and are not deleted. Without its system status it becomes an
ordinary page in Queries: shown as a row, movable and deletable.

Saved references are bare scope page ids today, in query profiles, chat transcripts and the search scope remembered
in localStorage. They become an unavailable reference: shown as such, and covering nothing until the user chooses
again. They are not reinterpreted as `collection(<same id>)`. If the user later flags an old scope page that had an
Exclude container, that would silently widen every chat still pointing at it. Profiles are rewritten this way by the
user log migration; transcripts and localStorage are mapped on read.

## Organization and discovery

Collections have a local home and global reach. There is no requirement to store every collection in a central
folder. For example:

```
Research
└── Northstar
    ├── Financials
    ├── Interviews
    └── Collections
        ├── Key sources
        ├── Risks
        └── Background
```

The Collections subpage is optional organization, not a reserved container. Key sources could live directly on
Northstar instead. A collection can contain items from anywhere the existing read rules support.

Add a **Collections** icon button to the toolbar's global group: right of the divider, immediately left of the user
icon. It is shown whatever item has focus, because collections relate to where the user is, not to the focused
item. It is hidden when no user is logged in. When the toolbar is hidden or in small-screen mode there is no
picker; collections remain reachable through the item tree. The icon must not resemble the page, link or
search/query icons (for example `bi-collection` or `bi-bookmarks`). It is highlighted while collection mode is
active. Check that the extra icon does not crowd the widest item toolbars (table, page) on narrow windows.

Its picker presents:

1. **Here:** collections ranked by how deep their nearest common ancestor with the current root page is, deepest
   first. Collections whose only common ancestor is the home page are left to All. The current root page is the
   page navigated to; focus in an embedded page or popup does not change it.
2. **All collections:** find a collection by name or home path across the account.

The server keeps the list of the account's collections, which All needs anyway. Here is computed by walking up from
each collection, never down from the current page, so a collection in an optional subfolder (Northstar /
Collections / Key sources, while browsing Financials) ranks near the top with no organization metadata and no
descendant scan.

Each entry shows its name, home path and direct-member count. Clicking an entry enters collection mode for it and
leaves the user where they are, since curating happens from the current location. While in the mode, clicking
another entry switches the destination. Names need not be globally unique; paths disambiguate duplicates.

There is no separate creation flow. A page becomes a collection, or stops being one, through **Make collection** /
**Make ordinary page** in the page's More actions (…) menu, next to the existing conversions. Making a page a
collection reinterprets content that is already there (its link children become members), which is deliberate and
infrequent, so it does not get a toolbar button. The More actions menu currently appears only when a conversion is
allowed or the focused page is the current page; widen that so any focused page the user can edit has it, including
embedded pages that cannot be converted. Because the flag is otherwise invisible:

- A collection page shows a marker by its title.
- The Collections picker, when empty, says how to make a collection.

## Collection mode

### Entering and identifying the mode

The only entry point is clicking an entry in the toolbar Collections picker. One collection is edited at a time;
switching to another lets outstanding saves finish.

No bar (tried, and more than the mode needs; under trial since 2026-11-17). In the mode, the toolbar's Collections
button names the collection beside its icon, inside a bold green border (amber once the collection is gone), and a
click on it leaves the mode. Its tooltip carries the home path, the member count of direct members, and how to
add and remove. Switching collection means leaving the mode and choosing again. Messages the marks can't show
(skipped items and why, still included via an ancestor, a failed save) use the toolbar's passing message; a failed
save puts its marks back, so clicking again is the retry.

Membership is shown by a translucent green fill (Tailwind green-600, `#16a34a`): stronger on direct members, faint
on items covered through an ancestor. An item covered only through a container that is itself filled on screen is
not filled again, since translucent fills stack. Page boxes (opaque, dark, white title) are recoloured green
instead (`mix-blend-mode: color`), which keeps the title readable. Outlines were used first, because in the
select-then-Add flow the blue selection fill showed on the same items; once clicks toggled membership without
selecting, the two rarely meet (only during a sweep, or a keyboard selection), and fills read better and need no
per-shape fitting (switched 2026-11-17, under trial). Green is the hue furthest from the blue selection and focus
ring. Purple was rejected: Text item titles are purple and it is one of the page colors. Marks are purely visual and
have no hit target. An item marked through one appearance is marked in its other appearances too.

### Adding and removing

Revised after trying step 7: selecting, then pressing Add or Remove, was twice the work. In the mode, the selection
gestures change membership directly instead of selecting. Plain clicking, editing, dragging and navigation behave
exactly as outside the mode, so opening a page never competes with adding it.

- **Cmd-click** (Ctrl-click off a Mac) flips the clicked item's own direct membership, a link as its target. An
  inherited item becomes a direct member. In a composite it is the member under the pointer. Attachments (e.g. a
  table's later columns) toggle too, though selection can't reach them; Shift-click on one toggles just it.
- **Shift-click** in an ordered container (list, table, composite) applies the last Cmd-click's change, add or remove,
  to the range from that item to the clicked one, as with checkbox ranges in mail clients. On spatial and calendar
  pages it toggles the one item, as selection does there.
- **Marquee** adds every item it covers, unless all are direct members already, when it removes them all; so a
  second sweep undoes the first. A composite is swept whole.
- No button for the page the user is on: it is clicked from its parent like any item. (Add this page was dropped:
  needed only for the root page, which holds everything anyway.)
- Add skips unsupported, missing or unreadable targets and says which and why.
- No Undo: a click is reversed by clicking again, a sweep by sweeping again.
- Selecting items for anything else (moving, grouping) means leaving the mode first. Keyboard selection (shift +
  up/down) still selects, with no membership effect.

| State | Appearance | Add (click or sweep) | Remove (click, or sweep of all members) |
| --- | --- | --- | --- |
| Not covered | No mark | Becomes a direct member | No effect |
| Direct member | Green fill | No effect | Removed |
| Covered through an ancestor | Faint green fill (none inside a filled container) | Also becomes a direct member, so it stays if the ancestor is removed | No effect; a message names the ancestor |

A member page, table or composite covers everything below it. To include only part of a covered subtree, remove the
parent and add individual contents; collections have no per-member exceptions. Adding an ancestor does not delete
existing descendant memberships, so removing the ancestor later leaves them intact.

Navigation, breadcrumbs, back/forward and search remain available, and the mode survives them. It is application
interaction state, not stored on a page or link. Search inside the mode is not limited to the collection being
edited, or the user could not find new members.

### Saving and leaving

Each change saves immediately. Marks change at the click; a failed change reverts its marks and offers Retry.

**Done** exits the mode and leaves the user where they are. **Escape** first clears the item selection if there is
one and closes an open popup; otherwise it exits the mode, after any open modal or editor that owns Escape.
Reloading leaves the mode. Right click (back) does not exit: it was tried, but navigating up while curating then
meant entering the mode again.

## Reviewing a collection

The collection page is the review. Its link children are the members, in membership order, rendered in whatever
layout the page uses. Links whose target has disappeared already render as broken; they cover nothing until
removed. Members are opened and removed as ordinary links. Removing a membership removes only the link; deleting a
collection does not delete its members.

## Search and chat UI

Search's filter menu and the chat scope control share one picker:

1. **Everything.**
2. **Collections,** grouped Here / All as in the toolbar picker. Each row has an **Except** action that selects
   everything except that collection.

The control's label states the choice in full, for example **Key sources** or **Everything except Private**, so an
exclusion is never mistaken for an inclusion. Membership is edited from the toolbar picker, not from here.

Choosing a collection limits search and direct reads; it does not attach the collection's content to the prompt.
Changing scope affects later retrieval, not what a chat has already read. An empty collection shows an explicit
empty-scope state.

## Missing collections

A chat, a query profile or search's remembered scope refers to a collection by id. Nothing prevents that collection
from being deleted, trashed or turned back into an ordinary page, directly or by deleting a page containing it.

- Retrieval covers nothing, never everything. A chat run refuses to start, with a message naming the collection;
  search returns no hits.
- The scope control shows the collection as unavailable, for example **Key sources (unavailable)**, until the user
  chooses again. Profiles show the same.
- Restoring the page from the trash, or setting the flag again, makes every reference work again, since the id is
  unchanged.
- No warning on delete.

## Retrieval

The resolver in `scope.rs` already handles include/exclude roots, canonical link targets, coverage through children
and attachments (never link targets), readability, cycles and missing targets, from live data. Collections change
only its input: it takes a `ScopeRef` (or a chat's chosen items), and a collection contributes its members' targets
as include roots, or as exclude roots for `everythingExcept`. The server enforces the result for search, LLM search,
direct reads and container listings, and collection-mode marks use the same coverage.

New rules:

- A missing collection resolves to nothing, never everything.
- A collection that is itself a member of another adds only its own page's subtree; membership does not compose.
- `scope_attachments.rs` must not attach a whole collection's content automatically.

Relevant code:

- [Scope resolution](infumap/src/web/routes/command/scope.rs): the page-based scope listing here is replaced.
- [Query configuration](infumap/src/query_configuration.rs), [search](infumap/src/web/routes/command/search.rs),
  [user record](infumap/src/storage/db/user.rs) (query profiles) and
  [transcripts](infumap/src/web/routes/command/chat/transcript.rs): bare `scopeId` becomes a `ScopeRef`.
- [Chosen-scope attachments](infumap/src/web/routes/command/chat/scope_attachments.rs).
- [Scope picker](web/src/components/items/QueryScopePicker.tsx) and [query scope state](web/src/items/query-scope.ts).
- [Page flags](web/src/items/base/flags-item.ts): the Collection flag.
- [Click selection](web/src/input/click_selection.ts): the item selection that Add and Remove act on.

## Implementation steps

Each step is one reviewable change that leaves the app working. Steps 1–4 make collections usable for search and
chat, curated by linking items into the page by hand; steps 5–8 add collection mode.

### 1. Collection flag and resolver (server only) — done

- `PAGE_COLLECTION_FLAG = 0x1000` in `infusdk/src/item/mod.rs`, `PageFlags.Collection = 0x1000` in `flags-item.ts`.
  0x004–0x020 are unassigned in TS too; check history before reusing them. 0x1000 is the next unused bit.
- `scope.rs`:
  - `collection_page(db, user_id, id)`: owned page, flag set, not under the trash page, else missing.
  - `collection_member_targets(db, user_id, page)`: direct link children in ordering, resolved through
    `resolve_content`, de-duplicated by target. Non-links are ignored. Unresolved links are dropped silently, since
    they already render as broken.
  - `enum ScopeRef { Everything, Collection(Uid), EverythingExcept(Uid), Unavailable }`, serialized as
    `{"kind": "...", "id": ...}`. `Unavailable` is what old bare scope ids become; the design names it but the
    three-variant type had nowhere to store it.
  - `resolve_scope_ref(db, user_id, &ScopeRef) -> ResolvedScope`. New `ScopeSource::Collection { id, name }` and
    `ScopeSource::Except { id, name }`. `Collection` uses `include_roots: Some(targets)`, so an empty collection
    is `Some({})` and covers nothing. `Except` is `All` plus exclude roots (what `for_chat` already does), and
    `contains` treats it like `All`. A missing collection gives `Some({})` and `ScopeSource::Unavailable` with
    `ScopeProblem::UnavailableCollection` (carrying the title when the page still exists); `ScopeRef::Unavailable`
    does the same with `ScopeProblem::RetiredScope`.
- Leave `resolve_scope` (scope pages) in place so nothing breaks yet.
- `TestDb` tests: empty collection; missing, trashed or unflagged collection; annotations not covered; member that
  is a link to a link; exclusion beats an include through another path; a collection that is a member of another
  covers only its own page subtree (should already hold, since `subtree_item_ids` never follows link targets);
  attachments of members covered.

### 2. Make collection / Make ordinary page, title marker (client only) — done

This has to come before references, because there is otherwise no way to set the flag and step 3 cannot be tried.

- `Toolbar_MoreActions.tsx`: toggle the flag through the normal item update. Widen the menu's visibility condition
  to any focused page the user can edit, including embedded pages that cannot be converted.
- Title marker on collection pages, in every place a page title renders: page box, list row, root page title,
  popup title. Check it against the item rendering and the toolbar, not just the menus.
- As built: the `bi-collection` glyph, never inside a contentEditable title. Page boxes (opaque, translucent,
  embedded) have it bottom-left, 12–16px, because the other corners hold the link triangle, attachments and resize
  triangle. List rows show it in the page colour in place of the thumbnail, since the thumbnail is often under 10px
  tall. Popup and toolbar titles have it after the title. A nested toolbar title gives up the glyph's width, so it
  stays aligned with its list column. Not offered on Home, Trash, Dock, Queries, Prompts or the search pages.

### 3. `ScopeRef` end to end (server and client in one change, since the wire format changes) — done

Server:
- `QueryConfiguration.scope_id` → `scope: ScopeRef`; `normalize` validates the id.
- User log v10 migration rewrites profiles: `scopeId: null` → `everything`, an id → `unavailable`.
- Transcripts: on read, map a configuration with `scopeId` the same way. New lines write `scope`. Extend the
  existing per-version transcript read tests.
- Search request `scopeId` → `scope`. Chat runs and the tool-test request (`chat/mod.rs`, `scopeId` and
  `scopeItemIds`) call `resolve_scope_ref`. Chosen items still win over the reference.
- `list-collections { currentPageId }` replaces `list-scopes`. It returns per collection: id, title, home path,
  direct member count and a Here rank (depth of the nearest common ancestor with `currentPageId`; none when that
  ancestor is the home page). Do the ranking on the server, since the client may not have the current page's
  ancestors loaded. Start with a scan of `user_items` for the flag; add an index only if it measures slow.
- `scope_attachments.rs` only attaches for `ScopeSource::Items`; add a test that a collection scope attaches
  nothing.

Client:
- `query-scope.ts`: the collection list replaces the scope list. One label function gives **Everything**,
  **Key sources**, **Everything except Private**, **Key sources (unavailable)** and an old-scope unavailable label.
- `QueryScopePicker.tsx`: Everything, then Here / All, with an **Except** action on each row, plus an explicit
  empty-scope state.
- `StoreProvider_General.tsx`: `searchScopeIds` becomes a per-account `ScopeRef`. An old string value reads as
  `unavailable`.
- `query-configuration-availability.ts`, `QueryProfileBar.tsx`, `query-configuration-labels.ts`,
  `query-configuration.ts`, `query.ts`: replace `scopeId`.

Decided: a chat run whose scope is unavailable refuses to start, as `resolve_item_scope` does when no chosen item
resolves. A run that silently finds nothing gives the model false negatives. The message names the collection when
its page still exists (trashed or unflagged, e.g. "Key sources is no longer a collection. Choose another scope."),
says it no longer exists when the page is gone, and says an old scope page is no longer supported for
`unavailable`. Search does not refuse: it returns no hits, with the unavailable label showing.

As built, beyond the list above:
- Transcripts are format version 4. Old `scopeId` is mapped by its key, not the header version, because live v2/v3
  files get v4 lines appended. The user log is version 10.
- From the Queries page, Here ranks against the previous page (`peekPrevPageVeid`): search and chat open on
  Queries, so ranking against it showed no Here section.
- The client no longer blocks search for an unavailable collection; the server returns nothing.
- `infumap tool` takes `--collection` / `--except` in place of `--scope`. `docs/scopes.md` describes collections.
- A collection picker filter appears from 7 collections. An unlisted collection's title comes from the item state
  when loaded, else "Collection (unavailable)".

### 4. Retire the Scopes system page — done

- Remove `scopes_page_id`, `ensure_scopes_page` (startup in `web/mod.rs`, `admin.rs`, `account.rs`), the
  account-response field, `scopesPageId` in `accountTypes.ts` and the store, `resolve_scope`,
  `resolve_scope_page`, `is_exclude_container`, `IgnoredContainer`, `MultipleExcludeContainers`,
  `NoResolvedIncludes`, `UnresolvedLink`, `ScopeSource::Named` (and its chat prompt line), `list_scopes`,
  `include_root_count`/`exclude_root_count` if unused, and `TestDb::scopes_id`. `handle_list_scopes` and the
  `list-scopes` command went in step 3.
- Port the tests that still build scopes from scope pages to collections: `scope.rs`, `search.rs`,
  `chat/mod.rs` and `chat/container_fragments.rs` (`resolve_scope` is test-only since step 3).
- `queries_subpage_name` and `listPageHiddenChildIds` also serve Prompts and the search pages. Drop only their
  Scopes entries; the design's removal list was too broad here.
- The existing Scopes page is left in place as an ordinary page. Check that it can be moved, deleted and converted
  once its system status is gone, and that its fixed id has no other special handling.
- The doc puts this in the same change as step 3. Keeping it separate makes review easier, and nothing uses the
  page after step 3.

As built: the Queries pin guard now lets a client unpin an ordinary page there, since the old Scopes page is still
pinned to the bottom; pinning anything, or unpinning the current chat or Prompts, is still refused. A new Prompts page
goes at the end of Queries (`new_ordering_between` lost its last use and went). Tests that combined an include with an
exclusion use `TestDb::scope_hiding`, which adds the exclusion through `ResolvedScope::for_chat`. The consistency
helper now expects links whose targets are out of scope to be left out of the allowed ids, which fixed the one
long-failing scope test.

### 5. Toolbar Collections picker and an empty collection mode — done

- Icon button in `Toolbar.tsx` immediately left of the user icon, hidden when logged out and in small-screen mode,
  highlighted while the mode is active. Check crowding with the table and page toolbars on narrow windows.
- Picker: Here / All from `list-collections`, name/path/count per row, empty state explaining Make collection.
- Mode state lives in the store (not persisted): collection id, entered by a row click, switched by another row.
- Bar under the toolbar: name (opens the collection page), home path, member count, Done. Escape clears the
  selection first, then exits, after modals and editors. Reload exits.

As built: `store.topToolbarHeightPx()` is now everything above the desktop (toolbar + bar); `toolbarHeightPx()` is
the toolbar alone, for drawing it and placing its popups. The bar shows only with the toolbar, so hiding the toolbar
or a small screen hides the bar, not the mode. Escape order: modals, editors, selection, item popups, then leaving the
mode, then focus-parent. Popups come before leaving so Escape can still close one opened while curating. The picker
reuses `QueryPickerPopover`; after a pick it drops focus from the toolbar button, or Escape would not reach the app.
Divider positions are functions of login now (one more icon when logged in). Fits at 780px with page and table
toolbars.

### 6. Membership marks — done

- `collection-coverage { collectionId, itemIds }` returns, for each item (a link resolved to its target), `direct`,
  `inherited { viaId, viaTitle }` or nothing. The client sends the target ids of rendered items, debounced on
  navigation and on view changes. This is exact without assuming the client has ancestors loaded, which it often
  won't for link targets that live elsewhere. Keyed by target id, so every appearance is marked.
- Outline rendering: `#16a34a` for direct members, lighter for inherited, no hit target, alongside the blue
  selection fill. Check against green pages.
- Refetch when the collection page's container version changes in sync. Limitation: if the collection page isn't
  loaded in this tab, changes made in another tab arrive only on the next navigation. That seems acceptable.

As built: one `CollectionMark` in each visual element dispatcher (desktop and line item), drawn as a sibling of the
item at its bounds, so every item type is marked without touching item components or arrange flags. Each rendered
mark asks for its item (`retainCollectionMark`); requests are batched per 30ms into `collection-coverage` and cached
per collection. Desktop marks sit outside the item with a 1px white gap: inside, they collided with the inset focus
ring and vanished on green pages. Line item marks stay inset, since rows touch. Roots, popups, the dock, trash,
list-page roots, previews and moving items are not marked. Marks refresh after this tab's item writes and after sync
changes (`onItemsChanged` in `server.ts`), and on navigation.

### 7. Add / Remove / Add this page — done

- Server commands `collection-add { collectionId, itemIds }` and `collection-remove { collectionId, itemIds }` in
  `item_ops.rs`. Add resolves targets, skips existing direct members, appends links after the last child, and
  returns skip reasons. Remove deletes every direct link child whose target matches, and names the covering
  ancestor for items that are only inherited. Both bump the collection's container version. Doing this on the
  server, not as client item creation, means the collection page needn't be loaded on the client and
  de-duplication is atomic.
- Bar buttons with counts ("Add 3"), Add this page (current root page or open popup), pending and failed state
  with retry or revert, and the "included via Financials" message. Selection stays after Add.

As built: the commands are in `command/collections.rs`, not `item_ops.rs`. Their responses carry no sync ack: the
client never saw the links made on the server, and an ack would mark them as already known; the next container sync
fetches them. On a spatial collection page, new links go 3 grid units below the lowest child. Add skips missing items,
passwords, broken links, trashed items and the collection itself, naming each. Marks are not changed optimistically:
they are fetched again after a save succeeds, so a failed save has nothing to revert and shows "Could not add N items."
with Retry. The server's reason does not reach the client, so a failure also refetches the collection list, which
shows "No longer a collection" if that was the cause. Remove with only inherited items selected explains which member
covers them. Still no keyboard shortcut.

### 8. Close selection gaps — done

- Calendar pages, composite members and notes in document pages under click selection and drag-select. These are
  selection fixes in `click_selection.ts` and the drag-select code, useful outside collections too.
- The Add/Remove keyboard shortcut is still undecided (it needs a modifier). Leave it out until chosen.

As built: document page notes were already selectable. Calendar pages now take Cmd/Shift-click as toggles, as
spatial pages do; the marquee still leaves them out, and the group/clean-up actions are not offered there. Composite
members drill in (decided): the first Cmd-click selects the composite; with the composite alone selected, or members
of it, Cmd-click selects a member, Shift-click a range of members. `mouse_down.ts` no longer swaps in the selected
composite for such a click. A selected composite member or calendar item drags on its own, not as a group move.
`docs/scopes.md` has a "Curating a collection" section.

### 9. Toggle on click, sweep and range — done

Replaces step 7's Add/Remove buttons, as revised under "Adding and removing" (decided: sweep adds unless all are
members, Shift-click repeats the last click, an inherited item becomes a member, a composite's member on click and
the whole composite on sweep). Marks change at the click (`showUnsavedCollectionMarks`), since a toggle reads the mark
it shows and a second click before the answer would otherwise repeat the first change; a failed save puts them back.
The step 8 composite drill-in still applies outside the mode. Later trimmed: no Undo, no Add this page. Right click
exiting the mode was tried and reverted.

### 10. No bar: the toolbar button shows the mode — under trial

The collection mode bar is gone, and with it `toolbarHeightPx` / `collectionBarHeightPx` (`topToolbarHeightPx` is
again the toolbar alone) and Retry. The Collections button grows to name the collection; `toolbarDividers.ts`
measures it, since the divider lines are placed from the window's right edge.

## Later

Left out of v1 to keep it small:

- A member listing with source paths and inherited coverage, as a page layout or overlay.
- A **Show this collection** filter on source pages.
- A mixed indicator for containers that hold members without being covered. It needs a third visual state and
  every ancestor of every member on the client.
- Recent collections in the pickers.
- Collection composition.
- Computed filters that produce a selection for the same retrieval machinery.
- Warnings when deleting a collection that something refers to.
