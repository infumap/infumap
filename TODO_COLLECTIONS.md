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
active, the same for every collection. Check that the extra icon does not crowd the widest item toolbars (table,
page) on narrow windows.

Its picker presents:

1. **Here:** collections ranked by how deep their nearest common ancestor with the current root page is, deepest
   first. Collections whose only common ancestor is the home page are left to All. The current root page is the
   page navigated to; focus in an embedded page or popup does not change it. This only affects ordering, since
   every collection is also reachable under All.
2. **Recent:** recently used collections, without duplicating entries already shown nearby.
3. **All collections:** find a collection by name or home path across the account.

The server keeps the list of the account's collections, which All needs anyway. Here is computed by walking up from
each collection, never down from the current page, so a collection in an optional subfolder (Northstar /
Collections / Key sources, while browsing Financials) ranks near the top with no organization metadata and no
descendant scan.

Each entry shows its name, home path and direct-member count. Clicking an entry enters collection mode for it and
leaves the user where they are, since curating happens from the current location; there is no separate View
action. While in the mode, clicking the selected collection again does nothing, and clicking another switches the
destination. Names need not be globally unique. References use identity; paths disambiguate duplicate names.

There is no separate creation flow. A page becomes a collection, or stops being one, through **Make collection** /
**Make ordinary page** in the page's More actions (…) menu, next to the existing conversions. Making a page a
collection reinterprets content that is already there: its link children become members. That is a deliberate,
infrequent change, so it does not get a toolbar button. The More actions menu currently appears only when a
conversion is allowed or the focused page is the current page; widen that so any focused page the user can edit has
it, including embedded pages that cannot be converted. Because the flag is otherwise invisible:

- A collection page shows a marker by its title, so it is never mistaken for an ordinary page.
- The Collections picker, when empty, says how to make a collection.

Normal item-tree navigation can open a collection too. The toolbar picker is a shortcut and index, not a separate
ownership hierarchy.

## Collection mode

### Entering and identifying the mode

The only entry point is clicking an entry in the toolbar Collections picker. An open collection page
needs no separate button: as the current root page it is always first under Here. Only one collection is edited at
a time. Switching to another finishes outstanding membership saves before switching the destination; it does not
discard the previous collection's changes.

Show a persistent bar immediately below the main toolbar:

```
● Key sources · Research / Northstar   8 members   [Add 3]  [Remove]  [Add this page]   Undo   Done
  Select items, then Add or Remove
```

The destination name and home path remain visible as the user navigates. Clicking the name opens the collection
page.

Membership is shown by highlight color alone, with no checkmarks or labels: a green outline (around Tailwind
green-600, `#16a34a`) on direct members and a lighter green outline on items covered through an ancestor. The marks
are outlines, never fills, because the item selection is a blue fill and both show at once on the same items; two
tinted fills would mix. Green is the hue furthest from the blue selection and focus ring. Purple was rejected: Text
item titles are purple and it is one of the page colors. The saturated green stays distinct from the muted green
page color, though marks inside green pages should be checked on screen. Reuse the same color for every
collection; the bar identifies which one is being edited. Marks are purely visual and have no hit target.

The count means explicit member roots, not the number of all covered descendants. Label it accordingly in detailed
views. If coverage counts are available, show them separately rather than presenting an approximate count as exact.

### Adding and removing

Membership changes only through the existing item selection: drag-select, Cmd-click (Ctrl-click off a Mac) to toggle
a single item, Shift-click for a range. Clicking, editing, dragging and navigation behave exactly as they do outside
the mode, so opening a page never competes with adding it.

- **Add** makes every selected item a direct member, a link as its target. Items that are already direct members
  are skipped. The label counts what will change ("Add 3").
- **Remove** removes the selected items that are direct members. Items covered only through an ancestor stay
  covered, and the bar says so ("1 is included via Financials").
- Add and Remove are separate because a selection can mix members and non-members, which would make a single
  toggle ambiguous.
- **Add this page** adds the focused page, either the current root page or an open popup, since neither can be
  drag-selected.
- A selection stays within one container, so adding from several containers takes one Add per container.
- Only items that selection can reach can be added. Calendar pages are not covered by click selection; composite
  members and notes in document pages need checking. Close such gaps in selection itself rather than adding a
  membership-only gesture.
- Add skips unsupported, missing or unreadable targets and says which and why, rather than showing a successful mark.
- A keyboard shortcut for Add and Remove is still to be chosen. Single-letter keys already create items, so it needs
  a modifier.

Ordinary navigation, breadcrumbs, back/forward and search remain available, and the mode survives them, including
opening a page as the application root. It is application interaction state, not inherited editability stored on a
page or a link. When adding from search, let search range outside the collection being edited, or the user cannot
find new members. Any retained search scope must be visible and changeable.

A canonical item marked through one appearance is marked in its other appearances too. Show the source path when
needed to make the shared identity clear.

The mode changes collection membership only. It does not change the target's permissions, content or normal link
editing behavior.

One-click per-item badges were considered (a check badge inset at each item's top-left corner) and set aside.
Cmd-click already covers single items, drag-select covers many, and badges would need a new hit target in every
layout. Revisit if Add proves slow in practice.

### Direct, inherited and partial membership

| State | Appearance | Add | Remove |
| --- | --- | --- | --- |
| Not covered | No mark | Becomes a direct member | No effect |
| Direct member | Green outline | No effect | Removed |
| Covered through an ancestor | Lighter green outline | Also becomes a direct member, so it stays if the ancestor is removed | No effect; the bar names the ancestor. No exclusion is created |

There is no mixed indicator for a container that holds members without being covered itself. Color alone has no
clear third state for it, and computing it needs every ancestor of every member sent to the client.

A member table includes its rows, cells and attachments. A member composite includes its members. A member page
includes its subtree. Its children are covered without being added individually, and show the lighter outline.

To include only part of a subtree that is currently covered, remove the parent and add individual contents.
Collections have no per-member exceptions.

Do not silently delete previously explicit descendant memberships when adding an ancestor. Removing the ancestor
must leave those deliberate memberships intact. Duplicate target roots are prevented.

### Saving and leaving

Each Add or Remove saves immediately. **Undo** reverses whole Add and Remove operations made in this session, most
recent first, not content edits or navigation. Apply inverse membership operations rather than restoring an old copy
of the entire collection, which could overwrite changes from another tab.

Show pending saves and failures. A failed mutation must revert its optimistic marks or clearly remain pending with
a retry; never label it saved. Done must not report completion while failed or pending changes are hidden.

**Done** exits the mode and leaves the user at the current location. **Escape** first clears the item selection if
there is one; otherwise it exits the mode, after any open modal or editor that owns Escape has handled it. There is
no Cancel action implying that already saved changes will be rolled back. Reloading leaves the mode; saved
membership remains.

## Reviewing a collection

The collection page is the review in v1. Its link children are the members, in membership order, rendered in
whatever layout the page uses. Links whose target has disappeared already render as broken; they remain until
removed and do not broaden coverage. Members are opened and removed as ordinary links. Removing a membership
removes its reference only. Deleting a collection does not delete its members.

There is no separate listing in v1. It would add each member's source path and what is covered through ancestors,
which a page of links does not show. Add it later, as a page layout or an overlay, if the plain page proves
insufficient. An on-page **Show this collection** filter on source pages is likewise later work.

## Search and chat UI

Search's filter menu and the chat scope control share one picker:

1. **Everything.**
2. **Collections,** grouped Here / Recent / All as in the toolbar Collections picker. Each row has an **Except**
   action that selects everything except that collection. Collections are not listed twice.

Recent records choices as made, so "Everything except Private" is one click once used. Editing a collection's
membership is done from the toolbar Collections picker, not from here.

The control's label states the choice in full, for example **Key sources** or **Everything except Private**, so an
exclusion is never mistaken for an inclusion.

On a collection, **Use in chat** opens a new query limited to `collection(<id>)`. This does not modify the default
profile or other chats.

Choosing a collection as retrieval scope does not automatically attach its entire content to the prompt. It limits
search and direct reads, with a bounded overview of the selection. Keep explicit whole-text attachments a separate
action. Existing chats retain material they have already read; changing scope affects subsequent retrieval, not
earlier context.

An empty collection produces an explicit empty-scope state. Missing collections or failed resolution must never
fall back to everything. Distinguish unavailable collections from successfully resolved empty ones.

## Retrieval rules and implementation foundation

The resolver takes a `ScopeRef` (or a chat's chosen items) and produces the existing include/exclude root sets: a
collection contributes its members' targets as include roots, or as exclude roots for `everythingExcept`. Reuse its
access checks, rather than introducing an independent client-side selection that the server does not enforce.
Membership coverage must agree across:

- The membership marks in collection mode.
- Ordinary search.
- LLM search and direct item reads.
- Container listings and any automatically supplied context.

Resolve roots through canonical children and attachments. A membership link resolves to its target, but arbitrary
links found inside a selected subtree are not recursively followed. Adding another collection as a member does not
implicitly compose its membership; collection composition is outside the first version. Collection definitions are
selection metadata, not research content to dump into the model's context.

Preserve structure needed to interpret selected material without admitting unrelated content. For example, a selected
table row needs its column labels; selecting a nested note may need an ancestor title/path. Such structural context
must not grant access to all siblings or the ancestor's full body.

Deduplicate canonical targets, handle cycles and missing targets, apply existing readability/trash restrictions, and
resolve membership from current data rather than waiting for full-text indexing to catch up. A root's subtree is
live: new descendants are covered, and descendants moved out cease to be covered unless separately selected.

Take a consistent resolved selection at the start of each search request or chat turn. Membership changes apply to
the next request/turn, so a running answer does not silently change its retrieval bounds halfway through.

Relevant existing code:

- [Scope resolution](infumap/src/web/routes/command/scope.rs): include/exclude roots, canonical target resolution,
  subtree coverage and availability reporting. The page-based scope listing here is replaced.
- [Query configuration](infumap/src/query_configuration.rs), [search](infumap/src/web/routes/command/search.rs),
  [user record](infumap/src/storage/db/user.rs) (query profiles) and
  [transcripts](infumap/src/web/routes/command/chat/transcript.rs): bare `scopeId` becomes a `ScopeRef`.
- [Container fragments](infumap/src/web/routes/command/chat/container_fragments.rs): scoped listings, canonical
  content access and structural context.
- [Chosen-scope attachments](infumap/src/web/routes/command/chat/scope_attachments.rs): existing automatic content
  inclusion, which must not be accidentally triggered for a whole collection.
- [Scope picker](web/src/components/items/QueryScopePicker.tsx) and
  [query scope state](web/src/items/query-scope.ts): existing scope selection and chosen-item behavior.
- [Page flags](web/src/items/base/flags-item.ts): the Collection flag.
- [Click selection](web/src/input/click_selection.ts): the item selection that Add and Remove act on.
- [Link items](web/src/items/link-item.ts): membership references use the existing link construct.
- [Navigation history](web/src/store/StoreProvider_History.tsx): browsing must not implicitly end collection mode.

## Implementation order

1. **Collection resolution and membership operations.** Collection flag, canonical roots, idempotent add/remove,
   direct/inherited/partial status, missing members and a shared coverage result. Membership changes must
   synchronize with other open views.
2. **Collection references, retiring scope pages.** `ScopeRef` in search, query configurations, profiles and
   transcripts, with old bare ids becoming unavailable; the shared picker with Except; Use in chat; removal of the
   Scopes system page and page-based scopes in the same change, since the old references stop resolving here.
   Collections are already usable at this point, curated by linking items into the page.
3. **Discovery.** Make collection / Make ordinary page, title marker, the toolbar icon and picker (Here / Recent /
   All).
4. **Collection mode.** Persistent destination bar, membership marks, Add / Remove / Add this page on the item
   selection, navigation/search continuity, save status, session Undo and explicit exit. This delivers the curation
   workflow. Close gaps in what item selection can reach (calendar pages, and any found in composites or document
   pages) as part of this step.
5. **Optional review and filtering.** A member listing with source paths and inherited coverage, or source-page
   filtering, only if reviewing the plain collection page proves insufficient. No expression language or general rule builder is needed for the initial delivery.

## Missing collections

A chat, a query profile or search's remembered scope refers to a collection by id. Nothing prevents that collection
from being deleted, trashed or turned back into an ordinary page, either directly or by deleting a page that
contains it. Decided:

- Retrieval covers nothing, never everything (see Retrieval scope).
- The scope control shows the collection as unavailable, for example **Key sources (unavailable)**, until the user
  chooses again. Profiles show the same.
- Restoring the page from the trash, or setting the Collection flag again, makes every reference work again with no
  repair, since the id is unchanged.
- No warning when deleting, trashing or unflagging a collection, or a page containing one. Finding the references
  would mean scanning profiles and chat transcripts, which is not worth it for a rare case in v1.
