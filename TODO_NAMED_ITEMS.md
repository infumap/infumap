# Named items and records

Design direction from discussion, not yet implemented. Two steps, each useful on its own: named attachments, then
records built on templates.

## Problem

Table columns give attachments their meaning by position: an attachment is "the second attachment", and only the
table knows slot 2 is called "H". A row is a tuple that means something only inside its table.

- Moving a row out of a table (e.g. a blood pressure reading: date, H, L, pulse) leaves attachments with no label.
- Moving a row into a table whose columns are in a different order silently relabels its values. This is the
  worse case, because the result looks valid.

## Value and scope

Named attachments is the part with lasting value. Templates are for people and have to justify themselves on use.

Verdict on what is known: a moderate win, probably worth doing, not a big one. It fixes a real correctness bug,
it's coherent, and it's opt-in, so trying it is low risk. Its value mostly depends on whether names get used outside
tables, which the contacts test (below) is the cheapest way to find out.

For:

- **Silent relabelling is a correctness bug,** and only stored names fix it for good. The cheaper alternative,
  matching headers at drop time when a row is dragged from table A to table B, only covers direct table-to-table
  drags, not a row that passes through a spatial page on the way.
- **Structure for chat, outside tables.** Same reasoning as grouping, which was added to help LLMs: a 125b model
  doesn't need it, a 35b model does, and it makes things simpler for both. But chat already gets column headers for
  tables (`column_names` in [container_fragments.rs](infumap/src/web/routes/command/chat/container_fragments.rs)), so
  inside a table the model already sees "H, L, pulse" next to positional values. Names only add something for values
  seen without their table: rows moved out, records on spatial pages, and search hits that land on a single
  attachment, where "Expiry" explains the value without loading the parent table. Not checked how search results
  present attachments.
- **Answers that cover everything.** Inference about one item ("this review relates to that hotel booking") gets
  better as models improve. Questions over everything ("every document expiring this year", "all readings over 140")
  don't: the model has to inspect each candidate, at a cost per item, and errors add up over hundreds of items, which
  matters on a local model. Named fields make those questions cheap and complete, to the extent the values are seen
  outside their tables (see above).
- **Visible to people.** Names show in column headers and the attachments table, so their value doesn't depend on
  models being weak. Structure that only helps the LLM loses value as models improve.
- **Foundation for records,** if they happen.

Against:

- No felt pull. Contacts is the only definite use, and a modest one.
- Many rules, and placement depends on names that mostly can't be seen. A row dropped into a table landing entirely
  in "+N" will confuse.
- No undo for drags, so wrong names stick.
- A lot of work: name field, matching, stamping, migration, server-side rename, marker, attachments table, clickable
  "+N", toolbar entry, chat fragments.

Templates (field items, layout, rendering a value in a field's slot) give the LLM almost nothing beyond what named
fields give, at most a list of expected fields to notice missing ones. So the LLM case justifies step 1, not steps 2
and 3.

Use cases. Records beat tables for things looked at one at a time, that mix images or files with short fields, and
that live outside tables. Tables beat records for comparing many items.

- Definite: contacts (headshot plus a few fields).
- Candidates: household documents (number, expiry, scan), purchases and warranties (date, price, serial, warranty
  end, receipt file), papers (authors, year, PDF, notes page), accounts (URL, username, email, and a field whose
  value is the existing password item).
- Not: company research. Compared across rows; a table with a research page per row already works.

Test before building templates: keep contacts as items with named attachments for a while, read through the
attachments table as a "label: value" list. If a laid-out form isn't missed, skip steps 2 and 3.

Where to stop. Records pull toward a relational database (relations, reverse lookups, rollups, enforced types,
saved views). Stop at:

- no computed values
- no enforced schema (already: field types guide input, they don't constrain values)
- no relation integrity: deleting a company doesn't touch the people linking to it
- no saved views beyond tables

Leave querying (by field, reverse relations such as "who works at X") and computation to chat over named fields,
rather than building a query language or evaluator. Unproven: chat is slower, isn't kept up to date the way a formula
column is, and isn't exact for arithmetic over many rows. If a self-updating column is wanted, the expressions
question comes back.

A grid type would pull toward spreadsheets the same way, and further from the item model: spreadsheets are built on
cells, not items, and expressions need an evaluator, cell references and recalculation. Expressions were removed once
already to cut scope. Out of scope here.

## Named attachments

An item has an optional field name (a string), read in the context of its parent. An empty name is no name, stored
as null. The name is stored on the value item itself, not only in a schema, so it goes with the item when it moves
to another parent as an attachment. An item that becomes a child loses its name (see below).

Two rules prevent most edge cases:

- **Displaying an item never changes it.** A table puts named attachments in the columns with the same name, and
  unnamed attachments in the unnamed columns, in order. Tables can mix named and unnamed columns, though usually a
  table will be one or the other. Attachments left over (named with no matching column, or unnamed with no unnamed
  column left) show as a "+N" indicator at the end of the row, never hidden. This is needed anyway for items a table
  shows but doesn't own (query results, links).
- **Moving an item can.** Dropping an item into a table names its unnamed attachments. Attachments that already
  have a name keep it. The unnamed ones go, in order, to the columns not taken by name: one landing in a named
  column gets that column's name, one landing in an unnamed column stays unnamed. Extras stay unnamed in "+N". So
  dropping in still fills columns as it does today, and the data stays named after the row moves out.

Cost of stamping: a wrong name persists (an image dropped into a blood pressure table becomes "H"). Accepted: it is
visible and fixed by renaming. Rejected alternative: never naming automatically leaves most data in named tables
unnamed, and stops attachments showing in named columns on drop.

### Column names

Columns have no name by default. An unnamed column is filled by position from the row's unnamed attachments, so a
table whose columns are all unnamed behaves as tables do today. Naming is opt-in per column, and naming a column is
when protection against silent relabelling starts for it.

Why not name every column (the earlier direction): the mixed rule below is needed anyway, because unnamed
attachments reach tables regardless (dropped onto rows, from spatial pages, extras in "+N"). So per-column naming
adds no new matching mechanism. Default names (`col N`, [Toolbar_Popup.tsx](web/src/components/toolbar/Toolbar_Popup.tsx))
would be junk, and names now decide where attachments show outside tables: a row moved out of a table with default
headers would show its values as "col 2", "col 3" in the attachments table instead of in the strip. With unnamed
defaults, a name always means someone chose it.

Cost: tables nobody names get no protection from silent relabelling. No worse than today.

Column 1 takes no part in matching or stamping: it always shows the title, and its header is only a caption (see
"The title (column 1)"). Everything here is about columns 2 onwards.

- Unnamed column headers show their position in grey, so "positional" is distinguishable from "empty".
- Naming an unnamed column stamps that name on the attachment each owned row currently shows in it.
- Renaming a column renames the field on every row in the table (see below).
- Clearing a column name clears the field on every owned row. Those values become unnamed and fill the remaining
  unnamed columns in order, so in a mixed table they can land in a different column. Allowed: the user did it and
  can see the result.

### The title (column 1)

Column 1 always shows the row item's title, so its header labels the title the way the other headers label
attachments. Decided: the title gets no field name. Two models are coherent, and one halfway position isn't:

- **(a) The title is the item's identity, not a field (chosen).** Every name then means one thing: the role a value
  plays in its parent. Column 1's header is the table's caption for its rows' identity, part of the table's schema,
  not stored on rows (as Notion and Airtable keep the primary field's name in the schema, not on the record).
- **(b) The title is a field.** The item stores a name for its title. It describes the item, not its relationship to
  a parent, so it would survive every move, including becoming a child. Columns become bindings to names, one of
  which resolves to the title, and column 1 stops being special: the title shows in the matching column or goes to
  "+N". Uniform inside tables, but names become two concepts (an attachment's is lost when the relationship ends, a
  title's is kept for good), and the title cell is currently the row's handle for opening and dragging, which a
  table without a title column would need some other way.
- **Halfway (rejected):** a title name stored on the item but column 1 still pinned to the title. It can't route, so
  it is only a label outside tables and a mismatch marker inside them. Half a concept.

Why (a): the title is already identity everywhere else (search, links, list views, chat fragment headings), so
making it a field goes against the rest of the model, and (b)'s uniformity only exists inside tables. The asymmetry
remains, but it can be explained in one sentence: attachments are values that need labels; the title is the thing
being labelled. Titles also usually describe themselves (a date, a person's name, a company name); bare numbers and
short strings in attachments are what lose their meaning. If records end up wanting titles to behave like any other
field, (b) is the design to revisit at records gotcha 2, not before.

It can't be the attachment name field reused on the row item anyway: that would mean "my title is the value called
Date" rather than "I am the value called H", and since rows are children of the table, the rule that becoming a
child clears the name would wipe it on every drop.

Worked example, the blood pressure table:

- Row: a note titled with the date and time, e.g. "2026-10-30 08:15". That is the reading's identity, as a diary
  entry is identified by its date.
- Attachments: notes named H, L, Pulse, values "128", "82", "64".
- Table: column 1 header "Date", the caption for row identity, not stored on rows. Columns 2 to 4 named H, L, Pulse
  by the user, so values dropped or typed in get those names.
- Moved out onto a page: the note "2026-10-30 08:15" with the marker; the attachments table shows H 128, L 82,
  Pulse 64. "Date" isn't shown, but a timestamp needs no label.
- Dropped into another table: H, L, Pulse go to the matching columns or "+N". The title goes in column 1 whatever its
  header. Under "Name" a timestamp looks wrong straight away, so that relabelling isn't silent; the dangerous case was
  128 moving from H to L, where both look valid.

What (a) asks of the user: put the identity in column 1. In a log, that is the time. The alternatives are worse: title
"BP reading" with the date as a "Date" attachment gives every row the same title and a meaningless column 1 (records
gotcha 2); column 1 bound to a "Date" attachment with the title hidden is (b).

Weak spots:

- The date is text. Sorting works with ISO format; questions like "readings over 140 in October" depend on chat
  parsing the title. True of every value here, since field types don't constrain, so not specific to titles.
- Two readings on one day need the time in the title to stay distinct. A convention, not enforced.
- A table whose column 1 isn't identity (a weight log with "Weight" first) works against (a). The answer is to
  reorder the columns, not change the model.

### Behaviour

- Typing into a cell creates an attachment named after the column (unnamed if the column is unnamed).
- Dragging an attachment from "+N" into a cell gives it that column's name. Into an unnamed cell, it is made unnamed
  and its order set so it lands in that column.
- Named and unnamed mixed: named attachments match by name; unnamed ones fill the unnamed columns in order.
- Order of named columns is display only. Unnamed columns are filled in column order, so reordering them changes
  which value shows in which, as today.
- Names don't match after moving between tables: the names are kept and the values show in "+N". A named
  attachment with no matching column never falls back to an unnamed column; that would make names positional again.
  Cost: rows dropped into a table with different column names put all their values in "+N" and leave the columns
  empty. Fine for one row, tedious for many; the fix is renaming the columns to match. A per-column "take values
  named X" action (a batch rename over the table's rows, like a column rename) is deferred.
- Moving an attachment to another item, as an attachment, keeps its name. Clearing it would make the value fill the
  next free unnamed column, which is the silent relabelling this design exists to prevent.
- Moving an attachment so it becomes a child (e.g. dragged onto a page) clears its name. A child note storing a name
  it doesn't show means nothing, and the name would come back without warning if the note were attached somewhere
  later. Clear it in `moveToNewParent` ([ItemState.ts](web/src/store/ItemState.ts)), where `groupId` is already
  reset when the relationship changes.
- Order still exists. It orders the attachment strip and the rows of the attachments table.
- Duplicate names on one item: the table shows the first, the rest go in "+N".

### Outside tables: attachment strip, marker, attachments table

Attachment tiles are too small to render text, so a name on a tile can't be seen. Names are shown in a popup
instead.

- **Strip:** shows unnamed attachments only, as today.
- **Marker:** shown only when the item has at least one named attachment, so items without named attachments carry
  nothing new. It takes the rightmost slot, where the first attachment goes today. Attachments are laid out right to
  left from the anchor, so that slot is placed first and the marker never overflows; unnamed attachments shift one
  slot left and overflow into the existing overflow marker as now
  ([attachments.ts](web/src/layout/arrange/attachments.ts)). It is pinned: not draggable, not reorderable, skipped
  by drop-position logic. Clicking it opens the attachments table. What it looks like at tile size is undecided:
  try it.
- **Attachments table** (popup): one row per attachment, all of them, named and unnamed, in attachment order. Column
  1 is the field name, column 2 is the item drawn as a line item. Editing column 1 names, renames or clears the name;
  the row stays in the table either way, and the strip updates. Typing in an empty last row adds a note attachment.
  Dragging a row out moves the item. Reordering rows reorders attachments.
- **Opening it:** from the marker, from the toolbar for the focused item (always available, and the way to add the
  first named attachment to an item that has none), and from "+N" in a table row (see below).
- **Dropping:** a drop in the usual attachment place on an item creates an unnamed attachment, as today, to the left
  of the marker. A named attachment can only be made by dropping into the open attachments table: the drop adds a
  row with an empty name and focuses its name cell.
- Dragging an unnamed row from the attachments table onto its own item's strip is a reorder, not a move.

"+N" in a table row: today this is [HiddenAttachmentsMarker](web/src/components/items/HiddenAttachmentsMarker.tsx), a
4px triangle with `pointer-events-none`, so the attachments it stands for can't be reached. Make it clickable, with a
hit area big enough to click ("+N" text or a larger target, not the triangle). It opens the attachments table showing
only the leftovers, since the other attachments are already visible in their columns. Same component, same
interactions, rows filtered:

- The name column shows the name for named leftovers and is blank for unnamed ones.
- Moving out works as anywhere: into a cell (takes the column's name, or becomes unnamed with its order set if the
  column is unnamed), onto another item (keeps its name), onto a page (becomes a child, loses its name).
- Typing a column's name into a name cell moves the value into that column, so it leaves the list. That is the
  visible effect of the edit.

Rejected alternative: show all attachments with a "shown in column" column. More general, but busier, and the only
case where the table's content would depend on where it was opened from.

Unnamed attachments appear twice, in the strip and in the attachments table. Accepted: two views of the same items,
as a page shown spatially and as a list.

In practice an item will mostly have either all named attachments (rows moved out of named tables, records) or all
unnamed ones, so with the marker in the rightmost slot, only the rare mixed case looks different from a plain strip.
Mixed still has to work (an unnamed image dropped onto a record, rows of a table with named and unnamed columns).

Rendering: reuse the table's rendering and interaction (row layout, hit testing, drag in and out, cell editing) with
a different column mapping: rows are the parent's attachments rather than the container's children, and column 1 is
the field name rather than the title. It is a virtual container. Query workspaces show items they don't own, which
may be a precedent; not checked whether the table code assumes rows are its own children.

### Renaming, migration

Renaming a column renames the field on every row in the table. Do it as one server-side command: items are in
memory with `children_of` / `attachments_of` indexes ([item_db.rs](infumap/src/storage/db/item_db.rs)), so it is
one request and N log appends. Undo is one inverse command. Rows owned by others keep the old name. Rows that left
the table before the rename keep the old name, which is correct.

Names stay plain strings, not field ids: tables created separately with the same column names match each other
without a shared schema. Ids would only pay off for renaming across a record type's records spread around the
system. That is a scan, or an index added later.

Migration: headers that still match a default become unnamed: `col N` for added columns, and "Title" for column 1
([table-item.ts](web/src/items/table-item.ts), [page-item.ts](web/src/items/page-item.ts)). Column 1's header is a
caption only (see "The title"), so this just keeps it consistent with new tables. Stamp names on existing table rows
from the remaining (user-chosen) headers, once: the drop rule applied to every row. Wrong only if someone
deliberately named a column "col N". Inserted columns are named `col ${insertHeaderIdx}`
([TableColumnContextMenu.tsx](web/src/components/overlay/TableColumnContextMenu.tsx)), so default names can repeat;
harmless once defaults count as unnamed, another reason not to stamp them.

Open:

- Should page ↔ table conversion stamp names too? Probably, since it is a move in all but name. Not checked what
  [page-table-conversion.ts](web/src/items/page-table-conversion.ts) does with attachments.
- How attachments are stored, rendered on spatial pages, and loaded with containers hasn't been checked.
- There is no undo for drag moves (the only undo history is [editor_history.ts](web/src/input/editor_history.ts),
  which covers page-local edits). A drop that stamps names, or a move that clears one, can't be undone; the fix is
  renaming by hand. Decide whether that is acceptable or drop undo is part of this work.
- The strip overflow marker on items (`AttachmentsOverflowMarker`, the left-pointing triangle) can't be clicked
  either, so attachments past it can't be reached. It could open the full attachments table. An existing gap, separate
  from naming; not decided whether to fix it here.

## Records

Records are built on templates:

- A **template** is a page (e.g. spatial) containing **field** items, a new item type. A field has a name, a type,
  and a position.
- A **record** references its template. Its **values** are named attachments. Opening a record renders the
  template's layout, with each attachment drawn where the field of the same name is.
- Field types: note (click and type), image or file (drop onto it).

Why attachments rather than named children: attachments are attributes and children are content. Tables then work
unchanged: a record is a row, its fields are columns, and expanding the row shows its content. Named children would
leave or duplicate their expanded rows once named. They would also need an extra container load per row to fill
columns.

What separating field from value gives:

- The template owns layout and definitions, so template changes reach all records (no copy vs live-link
  problem). A missing value is an empty field.
- A value is an ordinary item. Dragged to another record or row it keeps its name; dragged onto a page it becomes
  a plain child and loses the name. It keeps its type either way.
- Relations: a value can be a link item (e.g. "Employer" pointing at a company record).
- Attachments that match no field go in "+N", the same rule as tables.

Gotchas, roughly by expected pain:

1. **Template not visible**: shared without template access, template in trash, other user's space. Design a fallback
   rendering first: a plain item with a "label: value" list. The attachments table (marker plus popup) is that
   fallback. This is also how records show wherever the full template rendering doesn't fit.
2. **Record title vs a "Name" field**: tables use the row item's title as the first column. Let a field bind to the
   record's title instead of an attachment, or every table of records has a meaningless first column. The binding
   lives in the template (schema side), consistent with model (a) in "The title (column 1)". Revisit (b) here only if
   records need titles to behave like other fields.
3. **Records with their own children**: template layout plus the record's own positioned content collide on one
   canvas. In the first version, records have no children. Content is a field whose value is a page.
4. **Showing a value in a field's slot is a new rendering path**: an image filling the field's bounds, a note
   editable in place. Each item type allowed as a value needs it.
5. **Field types guide input; they don't constrain values**: renames and moves will put a note where an image field is.
   Render it anyway, perhaps with a mismatch marker.
6. **Editing a record vs editing the template**: field items are locked when viewing a record. Template edits happen
   on the template page, with a clear "affects N records" signal.
7. **Renaming a field**: batch rename as for columns, but records can be anywhere, so an index from template to
   records is needed. Block duplicate field names within a template.
8. **Records shown small**: scaled template miniatures could be slow and unreadable. Probably a compact form
   (title plus one or two fields).
9. **Tables of a record type**: deriving columns from fields ties renames in both directions. Keep them separate at
   first; columns match by name, with an "add columns from type" action.

Values with both attribute and content character (a person's headshot): stays an attachment; image fields must
render well. Test the design against this case first.

## Order

1. Named attachments, in two parts, using 1a before building 1b:
   - 1a: field name on items, unnamed-by-default columns, tables matching columns by name, stamping on drop,
     migration, server-side column rename, clickable "+N" opening the attachments table (filtered), field names in
     chat fragments. This fixes the blood pressure case once its columns are named. Migration and rename can't wait:
     under the matching rule a named column gets no unnamed values, so existing tables with user-chosen headers show
     everything in "+N" until migration stamps them. Chat fragments are part of this step, not deferred: names the
     model can't see give none of the chat benefit.
   - 1b: the marker on items, the unfiltered attachments table, toolbar access. The split saves less than it might
     look: 1a already builds the attachments table for "+N".
2. Only if the contacts test (see "Value and scope") shows a laid-out form is missed: field item type (name and
   type; note and image only), on spatial pages.
3. A record item referencing a template: rendering, typing and dropping into fields (the first input creates the
   attachment, as client-only creation does in [text_clipboard_create.ts](web/src/input/text_clipboard_create.ts)),
   and fallback rendering. This shows whether editing in place and the template vs record split feel right.
4. Deferred: miniatures, tables bound to types, propagating renames across records, title binding, search by field
   ("people where City = X"; chat first), a per-column "take values named X" action.
