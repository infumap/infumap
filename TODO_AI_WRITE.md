# AI writes to Infumap

Proposed design; not implemented. The target is a small set of composable write primitives over native Infumap
items. The JSON shapes below describe the proposed tool API, not the database schema.

## Goal

Let chat create and arrange native items. The main use cases are:

1. **In-place results.** Select an item, ask "summarize this", and put the summary beside it. Turn notes into a plan,
   break a document into tasks, translate it, or make flashcards.
2. **Research and extraction.** Find hotels and put them in a table with source URLs. Extract receipts into an
   expenses table or references into a reading list.
3. **Native structure.** Create populated pages, tables with pages or ratings in their cells, nested outlines and
   sample workspaces. A table cell is an item, not necessarily text.
4. **Organization.** Group chosen placements into pages, file them into existing project pages, or gather readable
   items as links without moving the originals.
5. **Empty cells and attachments.** Add researched websites, ratings or pages to empty cells. Attach a summary to
   each of several documents.
6. **Calendar entries.** Put a contract's deadlines on a calendar page, with explicit dates.

The model decides what to create and where it belongs. There are no task-specific tools such as `summarize`,
`organize` or `research_hotels`.

## Design direction

**Two write operations: add and move. Two shared concepts: items and destinations.**

- `infumap_add` creates typed native items at explicit destinations.
- `infumap_move` relocates existing placements.
- A page, link, rating, table or composite is an item type, not a separate operation.
- Attaching an item, appending a table row and filling an empty cell are additions at different destinations.
- Nested creation uses the same item specification throughout. Creating a populated page or table takes one call.
- The server handles ids, parent relationships, placeholders, ordering, dimensions and spatial placement.

Keep the conceptual model small. Minimizing function names is useful only while the arguments remain explicit:
changing the destination must not reinterpret prose or silently change the types being created.

Design the coherent API first, then evaluate how well models drive it. A more capable model may be necessary.
Do not make weak-model workarounds the foundation of the data model. Convenience tools can later call the same
primitives if there is evidence they improve reliability.

### JSON is the primary representation

Markdown cannot naturally express a native rating, a page inside a table cell or a link placement with independent
identity. Structure is therefore typed JSON. Prose is a field inside an item.

The existing [chat Markdown converter](infumap/src/web/routes/command/chat/markdown.rs) remains useful for rendering
chat answers and possibly for a later convenience importer. It is not the write API's intermediate representation.
A Markdown importer would compile into the same typed creation plan before validation and execution. There are no
special Markdown conventions for links, dates or table mutations in this API.

## Scope of the first version

Support notes, pages, ratings, links, dividers, composites and tables, including populated structures, attachments
and additions to empty table cells. Introduce these types incrementally through the same API. Add moves after the
creation and undo path works. Calendar writes follow once the date contract is settled.

Not included: deleting items, rewriting existing content, replacing occupied cells, changing permissions, creating
files, images or passwords, duplicating existing structures, or exposing arbitrary item fields.

Unattended scheduled writes are outside this proposal. The initial interface is an interactive chat with visible
changes and undo.

## Tool access and write authorization

The chat configuration's `capabilities` field lists internal IDs for groups of tools. The existing `infumap_data`
ID corresponds to the **Infumap** checkbox and enables search and read tools within the selected scope.
The proposal adds `infumap_write` for write tools. The host exposes those tools only in ordinary chat turns
with both IDs enabled. Deep research results can be saved in a later ordinary chat turn with writing enabled.

Enabling write tools lets the model request changes. Prompts can tell the model to ignore instructions in
retrieved content. The host enforces the user's authorization by checking each requested write before
executing it.

### Read scope, destinations and move sources

These are separate:

- **Read scope:** the existing retrieval scope, or the items chosen for reading and their covered descendants.
  Collections follow [the collections design](TODO_COLLECTIONS.md).
- **Write destinations:** the places the user has authorized to receive additions during this turn.
- **Move sources:** the existing placements the user has authorized the model to relocate.

A chosen item's parent can be a write destination without its siblings becoming readable or movable. Otherwise
"summarize this beside it" either fails or grants more authority than the request needs.

The host captures the invocation context when the message is submitted:

```json
{
  "destination": { "after": "infumap://selected-placement" },
  "selected": ["infumap://selected-placement"],
  "writeTargets": ["infumap://project-page"]
}
```

`selected` contains placement links. Selecting a link selects that appearance, not the original target elsewhere.
The host also records the resolved destination container and relevant placement revisions; these are execution
state, not fields for the model to invent.

With a selection from one container, the initial destination is after the last selected placement in displayed
order, or near it on a spatial page. Sorted and calendar containers use `into`, with their ordering rules. Without
a selection, an in-context invocation uses the end of its captured page. A selection across containers requires
an explicit destination. Navigating while the turn runs does not change its context.

Live chats reside under Queries, so their storage location is not an implicit output destination. An ordinary chat
uses a destination explicitly chosen in the chat. If none exists, an addition must name one and obtain any required
authorization; an omitted destination fails with `destination_required`.

### Write area

Initially authorize additions to the captured destination, explicitly chosen write targets, attachments of selected
items that support them, and containers created during the turn. Authorization is for the named destination, not
an automatic grant to all its descendants. Selected placements are the initial move sources; placements created
by the turn can also be moved.

Authorizing a table covers row additions and empty-cell additions to that table. It does not authorize adding
content inside an existing page held in one of its cells. Attachment destinations are similarly specific to their
holder. Move-source expansion requires the placements to be readable in the turn's scope before the model can
request their relocation.

Choosing an existing write target supplies its identity, path, layout and applicable table schema. This does not
add its existing contents to the read scope. Reading those contents still requires read authorization. New items
created during the turn are readable so the model can inspect and build on its own output.

A call outside the authorized destinations or move sources requires approval to expand them. A destination can be
outside the retrieval scope: the server verifies user access and shows its identity in the approval. It does not
reveal its existing contents through an error or broaden retrieval. If the model cannot discover a destination
within its read scope, the user can choose it explicitly.

Expansion approval names the requested destinations and source placements together. Approval covers those resources
for the rest of the turn, subject to the operation approval below. A decline returns `user_declined`; it is not an
invitation to retry through a different destination or representation.

Link targets must be readable within the turn's read scope or created by the turn. Server-side permission checks
still apply to every resource at execution time. Adding links to an existing collection uses its normal membership
rules; it does not grant new read authority during the running turn.

## Item specifications

An item specification describes what to create. It contains no persistent id, owner id, ordering key, raw flags,
coordinates or parent id. A `type` discriminator determines the allowed fields; unknown fields fail validation.

The initial vocabulary is:

| Type | Content fields | Meaning |
| --- | --- | --- |
| `note` | `text`, optional `style`, `indent`, `url` | One native note |
| `page` | `title`, `layout`, optional `items` | A page, optionally populated |
| `rating` | `value`, optional `display` | A native rating |
| `link` | `target` | A new placement referring to an existing readable item |
| `divider` | None | A native divider |
| `composite` | `items` | An explicit composite containing items |
| `table` | `columns`, optional `rows`, `title` | A native table with typed cells |

- `note.text` is literal text, including literal Markdown characters. `style` defaults to `paragraph`; supported
  styles are `paragraph`, `heading1` through `heading4`, `bullet`, `numbered` and `code`. `indent` is an optional
  list indentation level from 0 to 3. Invalid style combinations fail rather than being guessed. `url` makes the
  whole note text a clickable external URL and requires nonempty text; inline rich-text formatting can be added
  later. An internal item reference uses a `link` specification, not a note URL.
- `page.layout` is required: `spatial | list | grid | document | calendar`. A table-arranged page is a later layout
  extension; existing table-arranged pages accept the same row operations as table items.
- `rating.value` is an integer from 0 to 5, matching the current interactive rating scale. `display` defaults to
  `stars`: `number | stars | horizontal_bar | vertical_bar`.
- `link.target` is an `infumap://` item link. It always creates a link; it never moves or copies the target. A target
  which is itself a link is resolved explicitly to its content target, with access checked there too. Results expose
  both the new placement and resolved target.
- `table.columns` is an ordered list of `{ "name": "...", "align"?: "left" | "center" | "right" }`. The server
  chooses widths. `table.rows` uses the row specification below.

An item that natively supports attachments can also have `attachments: ItemSpec[]`. The same native validity rules
apply inside a page, composite, attachment or cell. Nesting does not bypass them. Nesting and empty container lists
are allowed; cycles and arbitrary references to not-yet-created items are not. A later call can use returned links.

### Rows and cells

A row is an insertion structure, not a new persistent item type:

```json
{
  "type": "row",
  "cells": [
    { "type": "note", "text": "Kyoto Inn" },
    { "type": "rating", "value": 4 },
    null
  ]
}
```

Use this same row structure inside `table.rows` and when adding rows to an existing table. `cells` follows column
order and must contain exactly one entry per column. `null` means an empty cell. A non-null cell contains exactly
one item specification; a composite explicitly groups several items into one cell. A row cannot itself be a cell.

Infumap stores the first cell as the row item and subsequent cells as its attachments. The server translates the
row structure into that representation and creates necessary placeholders. The first item must support owning
attachments when later cells are populated; reject an incompatible first-cell type with a specific error. For
example, a rating can occupy a later column beside a page in the first column. A blank first cell uses an empty
note as the row holder.

The first cell cannot separately specify `attachments`: those slots belong to the row's columns. Use `cells` for
them. This restriction also applies when filling an empty first cell. A page in the first cell can still have its
own child `items`, independently of the row's other cells.

Column references for existing tables are zero-based indices, exposed beside their names in reads. Names need not
be unique. The host records the column schema when it is shown to the model and checks it again at execution. A
rename, insertion or reorder causes `stale_schema` and requires a fresh read; a bare old index must not silently
address a different column. Explicitly chosen write targets provide this schema even when their contents are
outside the read scope.

### Calendar dates

Calendar children carry explicit `date: "YYYY-MM-DD"` and optional `endDate: "YYYY-MM-DD"` fields. The end date is
inclusive and cannot precede the start. These are placement dates, not text prefixes. Date fields are rejected at
non-calendar destinations in the initial API; calendar additions without a date also fail.

The host must supply the invocation timezone, and reads and writes must agree on which day is shown. This needs
implementation work: [calendar fragments](infumap/src/web/routes/command/chat/container_fragments.rs),
`calendar_prefix`, currently format UTC dates, while the
[client calendar](web/src/util/calendar-layout.ts), `calendarDateFromDateTime`, uses local dates. Do not enable
calendar writes until date-only round trips have a defined timezone contract. Changes to existing stored date
semantics remain an explicit design decision.

## Destinations

The shared destination vocabulary is:

```text
Destination = { into: <container link>, position?: "start" | "end" }
            | { after: <placement link> }
            | { before: <placement link> }
            | { attachTo: <item link> }
            | { cell: { table: <table link>, row: <row placement link>, column: <index> } }
```

Exactly one form is allowed. `into` defaults to `end`. A destination identifies where an item goes, not how to
parse its content:

- A page or composite accepts item specifications as children. A table or table-arranged page accepts row
  specifications. `before` and `after` within a table insert rows, not arbitrary children.
- An attachment destination accepts items only when its holder supports attachments. Use `cell` rather than
  `attachTo` when filling a table cell. Direct attachment additions to a row holder fail, so the column schema and
  occupancy checks cannot be bypassed.
- A cell destination accepts exactly one item specification and only when that cell is structurally empty. A
  placeholder or missing slot is empty; an existing page, rating, link or other meaningful item is occupied even if
  its displayed label is blank. An empty note with no URL, formatting or owned content is also empty. Filling a
  blank first cell must preserve the row's identity and other cells, and must satisfy the first-cell attachment
  constraint. Other columns in that row are not owned content of the first cell for this occupancy check. Implement
  this case explicitly rather than treating it as an ordinary attachment.
- Readable linked rows are not editable proxies. Cell writes through a linked row fail; the original row and its
  table must be addressed and authorized directly.
- Spatial destinations preserve the requested item types. The server positions items near the anchor without
  overlapping; it does not silently wrap them in a composite. Ask for a composite when one is wanted.
- `before` and `after` mean sibling order in manually ordered containers and proximity to the anchor on spatial
  pages. In spatial results, report the actual placement without claiming a linear visual order.
- Sorted containers determine their own displayed order. Explicit positional requests that conflict with that
  order fail; ordinary additions at `into` succeed and report the active sort. Calendar order is determined by dates.

An existing anchor is bound to its observed container and revision. If it moves or disappears, fail with
`stale_anchor`; do not follow it into another container. Resolve destinations before approval and revalidate after
approval, so the user approves the place that is actually changed.

### Default insertion cursor

Omitting `at` uses the turn's captured destination. For ordered insertion, it advances after each successful
default addition. Adding A and then B therefore yields A followed by B, rather than repeatedly inserting directly
after the original anchor and reversing the results. Failed calls do not advance it. Sorted and calendar
destinations retain `into` and their ordering rules instead of advancing to a positional anchor. Spatial defaults
retain the captured container and place each addition near the growing output area without overlapping.

Explicit destinations are literal and do not alter the default cursor. Calls and entries execute in request order;
an explicit later entry cannot depend on an item created earlier in the same call. Use nesting or a subsequent
call instead. Cell destinations are single-use locations, not advancing cursors. Results provide `nextAt` where
an explicit continuation makes sense.

## Tools

### `infumap_add(additions)`

```text
additions: [{ at?: Destination, items: (ItemSpec | RowSpec)[] }]
```

Each entry adds items at one destination. An array is the sole call shape, including for one entry; there is no
second single-entry overload. This batches several cells or attachments without separate tools or one call per
item. The whole call is atomic, including all entries and all nested items. Empty calls or empty entry item lists
fail validation.

There are no `create_page`, `create_table`, `create_rating`, `link`, `append_rows` or `fill_cells` tools. They are
all additions of explicit structures at explicit destinations.

For example, create a table with a populated page and a rating in one row:

```json
{
  "additions": [
    {
      "items": [
        {
          "type": "table",
          "title": "Kyoto hotels",
          "columns": [
            { "name": "Hotel" },
            { "name": "Rating" },
            { "name": "Website" }
          ],
          "rows": [
            {
              "type": "row",
              "cells": [
                {
                  "type": "page",
                  "title": "Kyoto Inn",
                  "layout": "document",
                  "items": [
                    { "type": "note", "text": "Near the station. Breakfast included." }
                  ]
                },
                { "type": "rating", "value": 4 },
                { "type": "note", "text": "Website", "url": "https://example.com" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

Fill a rating cell and attach a summary elsewhere in one call:

```json
{
  "additions": [
    {
      "at": { "cell": { "table": "infumap://table", "row": "infumap://row", "column": 1 } },
      "items": [{ "type": "rating", "value": 4 }]
    },
    {
      "at": { "attachTo": "infumap://document" },
      "items": [{ "type": "note", "text": "Summary of the document." }]
    }
  ]
}
```

Appending rows uses an entry with `at: { into: <table link> }` and `items: [<row>, ...]`. Adding a link uses
`items: [{ type: "link", target: <readable item link> }]`.

### `infumap_move(placements, at)`

`placements` is a nonempty ordered list of placement links; `at` is a required destination. Moves preserve the
items' content, descendants and attachments. Moving a link relocates that link, never its target. Input order is
preserved where the destination has manual order.

A move requires authority over both the source placements and receiving destination. It fails if a source has
changed location or ordering since it was shown to the model, or if the proposed move introduces a cycle. Reject
duplicate sources and a batch containing both an ancestor and its descendant.

The first move implementation supports ordinary children in non-tabular containers and native attachment moves
outside table rows. Moving into or out of a table row, or using a `cell` destination for a move, is deferred: it
needs explicit rules for preserving the source row and column structure. Whole table items can move normally.
Calendar moves are also deferred until changing placement dates has an explicit representation. Unsupported
destinations fail rather than implicitly converting a placement into a row or changing its date.

## Reads and tool results

Keep `infumap_search` and `infumap_get_fragment`. When writes are enabled, their output must expose the identity
needed to address placements:

- Every document block, including dividers and composites, carries its placement link.
- A link shows its placement and target separately, for example
  `[label](infumap://placement) → [target](infumap://target)`.
- Reading a link can continue to return the target's content, but the header identifies both the requested
  placement and resolved target. Mutation arguments never silently switch from one to the other.
- Tables expose their ordered column indices and names, row placement links, empty cells and native cell types.
  A page in a cell is shown as a page that can be read, not flattened into text.
- Completeness lines such as "items 1–20 of 57" and "rows 1–15 of 80" remain. Pagination is not a license to
  claim an entire container was processed.

Return a compact structured result with a readable activity summary. Map created links back to input paths such
as `additions[0].items[0].rows[0].cells[0]`, so the model can address the page it created without guessing. Expose
the top-level created placements, resolved destinations, created-item counts, applicable `nextAt` and ordering
warnings. Nested links should be available in the mapping; avoid repeating full created content in the result.

Errors have a stable code, affected input paths and a repair explanation. Distinguish invalid input, occupied
cells, stale schemas or anchors, declined authority and limits. Report all validation conflicts together where
possible, including duplicate writes to the same cell. Do not return out-of-scope cell content in an error.

## Execution and recovery

### Validate, authorize and commit a batch

Translate the request into a typed mutation plan. Validate types, native relationships, destinations, schemas,
occupancy, cycles and limits before changing anything. Gather any required approval, then revalidate mutable
preconditions at commit. Write calls execute sequentially; read-only tools can retain their existing concurrency.

The current [item add path](infumap/src/web/routes/command/item_ops.rs), `add_item_for_user`, validates and writes
an item in separate lock phases. The [item database](infumap/src/storage/db/item_db.rs) persists individual item
operations. Looping either path, even under one lock, does not give atomic batch persistence.

The new path must guarantee all-or-nothing application and recovery for a call, including its undo information
and retry identity. A lock handles concurrent visibility; a durable batch mechanism handles failures and restart.
The storage mechanism is an implementation design task, not an assumption that one lock solves it. Any required
persistent-format or backwards-compatibility decision must be resolved explicitly before implementation.

Before commit, cancellation leaves no changes. Once a batch is durably committed, cancellation or a lost response
does not erase its record. Reconnect exposes the completed changes and undo, even if the model never received the
tool result. A turn can contain several committed calls and later fail; retain and show those calls individually.

### Retry identity and limits

The host identifies an execution by user, turn and tool-call id and stores its outcome durably. Re-executing that
identity returns the same result without repeating mutations. A different payload under the same identity fails.
The model does not provide an idempotency key. A fresh model call is a new action, not automatically a retry.

Limits are named constants: total created items per call and turn, nesting depth, input size and moves per turn.
Count the full native expansion, including cells and placeholders, before commit. Limits and validation errors
must say what was exceeded. Retries of a committed call do not count twice.

### Sync and activity

Committed changes publish the appropriate container sync deltas and indexing work. Open views receive them through
`sync-containers` without disturbing an in-progress user edit. Publish a whole call's changes after commit.

Each write has an activity line with the destinations, counts and links to affected items. Results and activity
are recoverable from committed mutation records rather than depending on a final assistant message.

## Approval and undo

### Approval

Reuse `toolApproval`. `always_ask` asks before each write call. `automatic` permits additions within authorized
destinations, including additions to empty cells, but asks before moves. Both settings require approval to expand
authority. Combine expansion and operation approval into one concrete preview when both apply.

A preview shows what will be created or moved, where, and how many items are involved. Selecting a destination
authorizes that location; it does not waive `always_ask` or a move approval. Revoked permissions and stale
preconditions still fail after approval.

### Undo from the first exposed write

Every committed call records the created identities, any empty-cell representation it replaced, and each moved
placement's previous relationship, container, ordering and position. Undo information and mutation recovery must
agree durably. Transcript activity can refer to these records; writing effects first and appending undo data later
is insufficient.

Undo is a host action on a turn, not another model tool. Apply its inverse operations in reverse order. Check
mutation identities or revisions rather than just comparing current text or parent ids: an item may have changed
and returned to the same visible value.

- Trash generated items only when doing so preserves later user changes. Inspect descendants and attachments too;
  a generated page with new user content must be retained even if the page's own fields are unchanged.
- Restore a filled cell's prior empty representation only if that cell and generated subtree remain unchanged.
  Preserve other columns. Do not clear an entire row to undo one cell.
- Restore a move only if the placement has not subsequently been rearranged and its former destination is still
  valid and accessible. Never overwrite a later placement change or introduce a cycle.
- Report retained items and skipped inverse operations with reasons. Repeating undo must not apply it twice.

## Implementation sequence

1. **Typed mutation plan and durable batch path.** Establish validation, limits, retry identity, recovery and undo
   recording. Start with notes and explicit composites. Do not base this on Markdown conversion.
2. **One complete in-place flow.** Select an item, submit "summarize this", add beside it, see it in the open page,
   and undo it. Include the capability, captured destination, necessary placement links, approval and activity.
   Undo is part of this first exposed flow.
3. **Nested native creation.** Pages, links, dividers and ratings through the shared item specification, plus
   attachments and batches targeting several destinations.
4. **Tables.** Typed rows and cells, schema-aware reads, additions to existing tables, empty-cell destinations and
   their undo. Include page and rating cells; do not ship a text-only table API as the foundation.
5. **Existing destinations and moves.** Chosen write targets, authority expansion and relocation of explicitly
   authorized source placements. Use populated page creation and returned links for multi-step organization.
6. **Calendar dates.** Settle the timezone contract, make reads and writes agree, then expose dated additions.

Evaluate real tasks with the models in use as each slice becomes available. Measure wrong destinations, wrong
types, incomplete batches, excessive calls and recovery after errors. Grammar-valid JSON alone says nothing about
whether the requested structure is correct. Add convenience interfaces only in response to observed problems.

## Remaining design questions and later work

- **Batch persistence and revisions.** Choose the durable transaction/recovery mechanism and reliable revision
  tracking before enabling writes. Resolve any compatibility requirements with the user rather than assuming them.
- **Date-only storage.** Decide how the invocation timezone, calendar display and existing timestamps interact.
  Named timezones and daylight-saving changes cannot be replaced by one fixed UTC offset.
- **Table first-cell representation.** Implement identity-preserving filling and undo of an empty row holder.
  Keep native attachment restrictions explicit; relaxing them would be a separate item-model change.
- **Schema size.** Recursive typed structures can still produce large tool schemas. Measure them with actual
  providers and models. Convenience functions, flatter inputs or additional item types are later options, not a
  reason to hide structure in Markdown.
- **Rich text and Markdown import.** Define inline formatting or a convenience importer over the same mutation
  plan. Preserve the explicit distinction between an item and text that merely resembles one.
- **Large selections.** Prefer the host's explicit selected placement list for bulk operations. Do not introduce
  predicate mutations that operate on material the model has not inspected as a shortcut around incomplete reads.
- **General edits, copying and table moves.** Rewriting content, replacing occupied cells, duplicating structure,
  relocating cells or rows and moving calendar entries require their own semantics. Do not stretch `add` into an
  overwrite operation to keep the tool count at two.
- **Within-call references.** Nesting covers initial creation. Add temporary references only if tasks requiring
  cross-links between new siblings prove awkward to express through sequential calls.
