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
item into the collection page adds it, deleting the link removes it. Selection mode is the faster way to curate,
not the only one.

Clicking a link while selecting adds its target, not the link's placement. Selecting the same target from another
appearance does not create another membership entry.

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
search/query icons (for example `bi-collection` or `bi-bookmarks`). It is highlighted while selection mode is
active, the same for every collection. Check that the extra icon does not crowd the widest item toolbars (table,
page) on narrow windows.

Its picker presents:

1. **Here:** collections whose home is the current root page or an ancestor, nearest first. The current root page is
   the page navigated to; focus in an embedded page or popup does not change it. This only affects ordering, since
   every collection is also reachable under All. When browsing Financials,
   collections organized under Northstar's Collections subpage must also be discoverable here; do not require
   their immediate parent to be Northstar itself.
2. **Recent:** recently used collections, without duplicating entries already shown nearby.
3. **All collections:** find a collection by name or home path across the account.

Discovery through an optional Collections subpage needs explicit organization metadata or another bounded lookup;
do not recursively scan every descendant of every ancestor merely to populate this picker. The exact indexing
approach remains an implementation detail.

Each entry shows its name, home path and direct-member count, with **View** and **Select items** actions. Names
need not be globally unique. References use identity; paths disambiguate duplicate names.

**New collection…** asks for a name and shows its proposed home, defaulting to the current page. The home can be
changed before creation. Creating a collection immediately enters selection mode for it.

Normal item-tree navigation can open a collection too. The toolbar picker is a shortcut and index, not a separate
ownership hierarchy.

## Collection selection mode

### Entering and identifying the mode

Enter through **Select items** in the Collections picker, on an open collection, or beside the collection chosen in
a search or chat scope picker. Only one collection is edited at a time. Switching to another finishes outstanding
membership saves before switching the destination; it does not discard the previous collection's changes.

Show a persistent bar immediately below the main toolbar:

```
● Selecting for Research / Northstar / Key sources   8 members   Undo   Done
  Click to add or remove · Open to navigate
```

The destination name and home path remain visible as the user navigates. Purple identifies collection membership
in this mode, with checkmarks and text so color is not the sole indicator. Reuse the same color for every collection;
the bar identifies which one is being edited. Normal item selection must remain visually distinct.

The bar describes membership, not exclusion, even when the collection is entered from an "everything except" choice:
membership editing is the same whichever way the collection is used.

The count means explicit member roots, not the number of all covered descendants. Label it accordingly in detailed
views. If coverage counts are available, show them separately rather than presenting an approximate count as exact.

### Clicking and navigating

- Clicking an eligible item's body toggles direct membership. Existing content editing and dragging do not activate
  from that gesture while selection mode is active.
- Give items a separate, visible **Open** action. Opening a page navigates into it without selecting the whole page.
  Opening a document permits inspection without accidentally changing membership.
- Ordinary navigation, breadcrumbs, back/forward and search remain available. Selection mode survives them,
  including opening a page as the application root. It is application interaction state, not inherited editability
  stored on a page or a link.
- When selecting from search, let search range outside the collection being edited. Otherwise the user cannot
  find new members. Any retained search scope must be visible and changeable; do not silently constrain search to
  the collection under construction.
- Display a **Select whole page** action near the current page's title. The background of a page remains a place to
  navigate and inspect, not a giant implicit membership toggle.
- Selecting a canonical item through one appearance highlights its other appearances too. Show the source path
  when needed to make the shared identity clear.
- Unsupported, missing or unreadable targets cannot be added. Explain why rather than showing a successful mark.

The mode changes collection membership only. It does not change the target's permissions, content or normal link
editing behavior after the mode ends.

### Direct, inherited and partial membership

| State | Appearance | Click behavior |
| --- | --- | --- |
| Not covered | Empty checkbox | Add this item as a root |
| Direct member | Purple checkmark and highlight | Remove this explicit root |
| Covered through an ancestor | Lighter highlight, checkmark, "Included via Financials" | Explain the parent selection; do not silently create an exclusion |
| Contains selected descendants, but is not itself covered | Mixed indicator | Add the whole container as a root |

A selected table includes its rows, cells and attachments. A selected composite includes its members. A selected
page includes its subtree. Unmarked children of such a root remain covered; they do not need individual marks.

To select only part of a currently selected subtree, remove the parent root and choose individual contents.
Collections have no per-member exceptions.

Do not silently delete previously explicit descendant memberships when adding an ancestor. Removing the ancestor
must leave those deliberate selections intact. The collection view distinguishes explicit roots from inherited
coverage, and duplicate target roots are prevented.

### Saving and leaving

Each toggle saves immediately. **Undo** reverses membership changes made in this selection session, not content
edits or navigation. Apply inverse membership operations rather than restoring an old copy of the entire collection,
which could overwrite changes from another tab.

Show pending saves and failures. A failed mutation must revert its optimistic mark or clearly remain pending with
a retry; never label it saved. Done must not report completion while failed or pending changes are hidden.

**Done** exits the mode and leaves the user at the current location. **Escape** does the same after handling any
open modal or editor that owns Escape. There is no Cancel action implying that already saved clicks will be rolled
back. Reloading leaves selection mode; saved membership remains.

## Reviewing a collection

**View** opens a complete listing of the collection's explicit member roots in membership order. Each entry shows
its source path and makes subtree inclusion clear. Entries whose target has disappeared remain visible as broken
members until removed; they do not broaden coverage.

Allow opening source items, removing memberships and entering selection mode from this view. Removing a membership
removes its reference only. Deleting a collection does not delete its members.

The view includes roots from outside the collection's home. A collection is not limited to what is currently visible
on the source page, and a partial or paginated listing must not be presented as its complete contents.

An on-page **Show this collection** filter can later reuse the same coverage result. It is not required for the first
version: the collection's own view supplies review without immediately implementing filtering in every page layout.

## Search and chat UI

Search's filter menu and the chat scope control share one picker:

1. **Everything.**
2. **Collections,** grouped Here / Recent / All as in the toolbar Collections picker. Each row has an **Except**
   action that selects everything except that collection. Collections are not listed twice.

Recent records choices as made, so "Everything except Private" is one click once used. The chosen collection shows
**View**, **Select items** and **New collection…** beside it.

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

- The selection highlights and collection view.
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
- [Link items](web/src/items/link-item.ts): membership references use the existing link construct.
- [Navigation history](web/src/store/StoreProvider_History.tsx): browsing must not implicitly end the selection session.

## Implementation order

1. **Collection resolution and membership operations.** Collection flag, canonical roots, idempotent add/remove,
   direct/inherited/partial status, missing members and a shared coverage result. Membership changes must
   synchronize with other open views.
2. **Collection references, retiring scope pages.** `ScopeRef` in search, query configurations, profiles and
   transcripts, with old bare ids becoming unavailable; the shared picker with Except; Use in chat; removal of the
   Scopes system page and page-based scopes in the same change, since the old references stop resolving here.
   Collections are already usable at this point, curated by linking items into the page.
3. **Collection view and discovery.** Create/name/home, local and global lookup, complete member listing and source paths.
4. **Selection mode.** Persistent destination bar, membership gestures, distinct Open actions, whole-page selection,
   navigation/search continuity, save status, session Undo and explicit exit. This delivers the curation workflow.
5. **Optional source-page filtering.** Reuse resolved coverage across layouts only if reviewing the separate collection
   view proves insufficient. No expression language or general rule builder is needed for the initial delivery.

## Decisions still required

- **Local discovery:** how a collection organized in an optional subfolder advertises its association with the company
  page, without ambiguous title conventions or unbounded descendant scans.
- **Deletion lifecycle:** saved references are not items, so nothing stops their collection from being deleted,
  trashed or unflagged. Decide how affected profiles, chats and the remembered search scope are reported and
  repaired, and what deleting a parent containing collections should expose. Do not silently detach or broaden.

The interaction above is the proposed first implementation. These decisions do not need to be settled to review the
workflow, but must be settled explicitly before changing existing behavior.
