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

Show a persistent bar immediately below the main toolbar:

```
● Key sources · Research / Northstar   8 members   [Add 3]  [Remove]  [Add this page]   Done
  Select items, then Add or Remove
```

The name and home path stay visible as the user navigates; clicking the name opens the collection page. The count
is direct members, not covered descendants.

Membership is shown by highlight color alone: a green outline (around Tailwind green-600, `#16a34a`) on direct
members and a lighter green outline on items covered through an ancestor. The marks are outlines, never fills,
because the item selection is a blue fill and both show at once on the same items. Green is the hue furthest from
the blue selection and focus ring. Purple was rejected: Text item titles are purple and it is one of the page
colors. Check marks inside green pages on screen. Marks are purely visual and have no hit target. An item marked
through one appearance is marked in its other appearances too.

### Adding and removing

Membership changes only through the existing item selection: drag-select, Cmd-click (Ctrl-click off a Mac) to toggle
a single item, Shift-click for a range. Clicking, editing, dragging and navigation behave exactly as they do outside
the mode, so opening a page never competes with adding it.

- **Add** makes every selected item a direct member, a link as its target. Items that are already direct members
  are skipped. The label counts what will change ("Add 3").
- **Remove** removes the selected items that are direct members. Items covered only through an ancestor stay
  covered, and the bar says so ("1 is included via Financials").
- Add and Remove are separate because a selection can mix members and non-members.
- **Add this page** adds the focused page, either the current root page or an open popup, since neither can be
  drag-selected.
- Add skips unsupported, missing or unreadable targets and says which and why.
- A selection stays within one container, so adding from several containers takes one Add per container.
- Only items that selection can reach can be added. Calendar pages are not covered by click selection; composite
  members and notes in document pages need checking. Close such gaps in selection itself.
- A keyboard shortcut for Add and Remove is still to be chosen. Single-letter keys already create items, so it needs
  a modifier.

There is no Undo. Items stay selected after Add, so a mistaken Add is reversed by pressing Remove.

| State | Appearance | Add | Remove |
| --- | --- | --- | --- |
| Not covered | No mark | Becomes a direct member | No effect |
| Direct member | Green outline | No effect | Removed |
| Covered through an ancestor | Lighter green outline | Also becomes a direct member, so it stays if the ancestor is removed | No effect; the bar names the ancestor |

A member page, table or composite covers everything below it. To include only part of a covered subtree, remove the
parent and add individual contents; collections have no per-member exceptions. Adding an ancestor does not delete
existing descendant memberships, so removing the ancestor later leaves them intact.

Navigation, breadcrumbs, back/forward and search remain available, and the mode survives them. It is application
interaction state, not stored on a page or link. Search inside the mode is not limited to the collection being
edited, or the user could not find new members.

### Saving and leaving

Each Add or Remove saves immediately. Show pending saves and failures: a failed change reverts its marks or stays
pending with a retry, and is never shown as saved.

**Done** exits the mode and leaves the user where they are. **Escape** first clears the item selection if there is
one; otherwise it exits the mode, after any open modal or editor that owns Escape. Reloading leaves the mode.

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

- Retrieval covers nothing, never everything.
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

## Implementation order

1. **Collections and resolution.** Collection flag, membership add/remove, direct/inherited coverage, missing
   members, `ScopeRef` input to the resolver. Membership changes synchronize with other open views.
2. **References, retiring scope pages.** `ScopeRef` in search, query configurations, profiles and transcripts, with
   old bare ids becoming unavailable; the shared picker with Except; removal of the Scopes system page and
   page-based scopes in the same change. Collections are usable from here, curated by linking items into the page.
3. **Discovery.** Make collection / Make ordinary page, title marker, toolbar icon and picker.
4. **Collection mode.** Bar, marks, Add / Remove / Add this page, save status, exit, and closing the gaps in what
   item selection can reach.

## Later

Left out of v1 to keep it small:

- A member listing with source paths and inherited coverage, as a page layout or overlay.
- A **Show this collection** filter on source pages.
- One-click per-item badges (a check badge inset at each item's top-left corner), if Add proves slow.
- A mixed indicator for containers that hold members without being covered. It needs a third visual state and
  every ancestor of every member on the client.
- Recent collections in the pickers.
- Undo in collection mode.
- Collection composition.
- Computed filters that produce a selection for the same retrieval machinery.
- Warnings when deleting a collection that something refers to.
