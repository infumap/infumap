# Showing items as text

Parked idea from discussion, not implemented: a toolbar toggle that makes a page render like a note wherever it is
shown, instead of as a box. Don't build it until there are real cases for it (see Value).

## Origin

It started with pages in composites and document pages, which might be better rendered as lines, as they are in
tables. It then generalized to pages in any context, and possibly tables and images.

## Value

Unproven. There is no specific case yet: no document in actual use has pages in it. The appeal so far is mostly
flexibility that might get used.

| Use | Value | Existing alternative |
| --- | --- | --- |
| Related pages listed in a document | Plausibly useful | A table in the document shows pages as rows, and its title and headers can be hidden |
| Pages in a composite | Same | Same, tables work in composites too |
| Labels instead of page boxes on a spatial page | Most distinctive, nothing else gives a wrapped text label that opens a page | Small page boxes, which are bulkier and harder to read |
| Images as text | Weak | Rarely needed |
| Tables as text | Weak | A page containing the table |

The table alternative hasn't been tried for this. It isn't equivalent: the rows sit in a table rather than flowing with
the text, and the pages have to go inside it.

Costs:

- Stored format is permanent: flag bits and a link field stay in stored data and the SDK even if unused.
- Every later change to note layout has to consider this mode, and a missed case shows up as a subtle bug.
- More to explain: types look alike but click differently, and the button does nothing in some contexts.

Next steps:

1. Try a table of pages in a real document, to see whether this is wanted and whether the table feels wrong.
2. Wait until it comes up a couple of times in real use. Those cases show which version is needed. Spatial may matter
   more than documents, which would change the build order.
3. To try it sooner, build pages only with a page flag and no link field. An unused flag is harmless, so this needs no
   SDK change and is easy to back out, but links stay full view, so it doesn't help if links turn out to be the real use.

## Decisions

If it gets built:

- **The toggle is always available.** On an open page it shows no visible change, as with "Interactive when embedded".
- **The state stays with the item when it moves.** An earlier idea, forgetting it on leaving a composite or document, was
  dropped. Parents change mid-drag, so a row would jump to a full page when dragged across a page boundary.
- **Pages render like a default note in all contexts.** Notes already have geometry for spatial, composite, document,
  list and cell layouts, which also settles attachments, width-only resizing and spacing. Grid and justified pages are
  fine for the same reason, unlike the earlier one-line row idea.
- **The icon is the one the item has in list and table rows.** Coloured thumbnail for pages. Without it a page can't be
  told from a note except by clicking. It goes in the note's icon slot, which already opens a popup.
- **Links choose independently.** A new link copies the current stored state, even when the source is being viewed as a
  table row, where stored state and appearance differ.

## Proposed, not decided

- **Storage:** a flag on pages, since the state is no longer tied to the parent. Links have no flags and need one new field,
  like `aspectOverride`, which means an SDK change.
- **Copying to new links:**
  - Dragging a link should copy the dragged link's state. `LinkFns.createFromItem` is passed the target.
  - Popup and list-pane links keep the full-view default, so they keep showing the full item.
  - Don't copy in `syncSizeFromLinkedItem`: search calls it for temporary links, so results would change.
  - An empty link has nothing to copy, so it starts as full view.
- **Where it's ignored:** open pages (root, popup, the list's selected-item pane) still show in full. List, table and
  calendar rows are already rows, and the dock has its own form. The button is disabled on a focused table row.
- **Clicks:** keep what each item already does rather than a note's edit-on-click: a page opens, an image opens a popup, a
  table edits its title. Dropping an item onto a page still moves it inside.
- **Not available in this mode:** note styling such as headings, bullets, alignment and inline marks. Flag bits mean
  different things per item type, so note code can't read `page.flags`.
- **Interactive:** this and interactive are really one setting with three values (preview, interactive, note). Turning
  either on clears the other.
- **Width:** shared with the full view. A default page is 4 blocks wide, so long titles wrap.
- **Name:** describe what it does, e.g. "Show as text when embedded", so that lists and tables already doing this doesn't
  read as a bug. The tooltip can say they always do. Check the wording also fits tables and images.

## Implementation notes

From reading the code, not prototyped.

- Use one helper for whether an item shows as text, checking the link first, and one component with a per-type icon.
- Rendering needs a new component, since `Note.tsx` assumes a real note and is built around editing it.
- Don't reuse `VisualElementFlags.LineItem`. Many places treat it as a list or table row.
- Don't change `PageFns.calcSpatialDimensionsBl`: the page's own geometry uses it, and open pages must stay full size.
  Dispatch above it instead.
- For links, stamp the state onto the cloned measurable, as `aspectOverride` does.
- There are 96 `isNote` checks across 30 files. Most concern editing, but perhaps a dozen layout ones (e.g. document
  spacing, composite height) need to treat these items as notes.

Build order: pages and the link field, then images, then tables.

### Images

Easy, as they have no children. The title is usually a filename, so a document may show `IMG_2041.jpg`. Previews exempt
images from the outline cutoff, which has to stop in this mode because text doesn't stay recognizable when small. Crop and
border have no effect.

### Tables

The risky part, and droppable without affecting the rest.

- `arrangeTable` has to be skipped, and it's called from at least six places.
- Hit-testing and path code assumes a table has arranged children, so a missed case could mean a wrong hit or a crash.
- A table with `HideTitle` still needs its title as the text. A click on one currently only focuses it, so the title
  couldn't be edited without changing that.
- Contents are only reachable through the icon popup, which hasn't been confirmed to work well for every table.
- Columns, headers and wrapping have no effect.
- Add the bit to the page/table conversion pairs (`PAGE_TABLE_FLAG_PAIRS` in the web code and the SDK), so the state
  survives conversion.

Files, text and passwords already look like this, and composites have their own collapsed form, so it shouldn't extend
further.
