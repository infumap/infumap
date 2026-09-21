# Infumap chat tools

Chats with the Infumap data source enabled have three built-in read-only tools:

- `lexical_search`: find items using their titles and indexed document text.
- `read_page`: inspect a page's items and their relationships without requiring a search match.
- `get_fragment`: read a bounded document fragment.

Search results include `containingPageId` and `ancestors` with `id`, `itemType`, and `title`.
`containingPageId` is the nearest ancestor page, excluding the result itself. For a page result,
use its own `itemId` to inspect that page. The existing label-only `path` is also returned.

## Reading a page

```json
{
  "pageId": "<page ID>",
  "maxItems": 100
}
```

`pageId` is required. `maxItems` is optional, defaults to 100, and accepts 1–200.
The tool reads stored workspace data, independently of which items are currently loaded or visible
in the browser. It follows the chat tools' existing ownership scope and excludes password items.

The response contains:

- `page`: identity, title, citation link, and layout.
- `ancestors`: navigable ancestor identities, from the root downwards.
- `items`: page children, their attachments, and recursively expanded inline composites and tables.
- `groups`: explicit groups represented by the returned items.
- `totalItems`, `startIndex`, `hasMore`, `nextCursor`, and `snapshot`: coverage and continuation metadata.

Child pages remain references, including embedded pages. Their `childrenStatus` is `reference`;
call `read_page` with that page's ID to inspect its contents. Page attachments are included.
Query results and chat transcripts are client-generated views and are not expanded by this tool.
Document bodies are not included. The `scope` object makes these boundaries explicit.

### Items and relationships

Each item record includes `itemId`, `itemType`, `linkUrl`, `parentId`, `relationshipToParent`,
`placementPath`, `order`, and `title`. Native note text is stored in `title`; file titles are filenames,
not extracted document text. `parentId` and `relationshipToParent` describe the stored relationship.
`order` is zero-based within the parent's children or attachments, separately.

For links, `itemId` identifies the link's placement, while `targetItemId`, `targetItemType`, and
`targetLinkUrl` identify its readable target. `title` and document metadata come from that target.
`linkTo` preserves the stored reference. Unresolved, remote, or inaccessible targets have
`targetStatus: "unavailable"` and no target content. Attachments and inline contents come from
the displayed target, matching the frontend. `placementPath` distinguishes repeated appearances
of those contents even when their stored `itemId` and `parentId` are the same.
Cycles stop expansion and are marked with `childrenStatus` or `attachmentsStatus` of `cycle`.

`groupId` represents explicit membership among page children, independently of parenthood.
Group summaries include `memberCount`, `returnedMemberIds`, and `membershipComplete` for the
current response. Members can span responses; collect them by group ID. Proximity and matching
titles do not establish group membership.

Native notes also include URL annotations intersecting the returned text. Annotation `start` and
`end` retain their UTF-16 offsets into the full note, as stored by the editor. Ratings include their
value and rating type.

### Layout

`layout.mode` identifies the arrangement. `returnedOrder: "stored"` follows saved ordering with
an ID tie-breaker. Title-sorted containers use `returnedOrder: "title-unicode"`, a deterministic,
case-insensitive Unicode sort; the browser's locale-sensitive title ordering may differ. Document
pages always use stored order. Spatial ordering is not a claimed reading sequence.

Only direct children of spatial pages receive `spatial` coordinates. `frameItemId` identifies the
containing page; the frame has its origin at the top left, x increasing rightwards and y downwards.
Units are Infumap grid units, with 60 grid units per block. Width is included when stored. Height
is included only for types that use a stored height; other heights depend on frontend measurement.
These are stored placements, not exact rendered bounds or viewport pixels. Attachments and
non-spatial children do not expose their unused saved coordinates.

Table layouts include column names and indices. Rows are child items and subsequent cells are
the row's ordered attachments. Calendar children include `dateTime` and `endDateTime` in Unix
seconds. Client sorting, scrolling, collapsing, and responsive layout are not a rendered snapshot.

### Pagination and text availability

Continue with the same page ID and the returned cursor:

```json
{
  "pageId": "<same page ID>",
  "cursor": "<nextCursor>"
}
```

Responses target a 32,000-character item budget, in addition to `maxItems`. Metadata and the first
item may exceed that budget. Long item titles/native notes are split into 4,000-character chunks:
`titleOffset` is a zero-based Unicode character offset and `titleTruncated` means more of that title
remains. The next cursor continues the same placement before advancing to subsequent items.
Reassemble chunks by `placementPath`. Page and ancestor labels are abbreviated at 500 characters
with an explicit `titleTruncated` flag.

Follow all cursors until `hasMore` is false to cover the outline. A continuation detects changes
to the stored outline and asks the caller to restart instead of silently skipping or duplicating
items. Cursors are scoped to a page. Outlines exceeding 50,000 placements or 64 levels return an
explicit error instead of claiming complete coverage.

For file, text, and image items, `textSource` reports document fragment availability:

- `available`: includes the content `itemId`, `sourceKind`, `fragmentCount`,
  `firstFragmentOrdinal: 0`, and `tool: "get_fragment"`.
- `unavailable`: no usable fragment manifest and data file were found.
- `error`: availability could not be checked.

This reads fragment metadata without loading document bodies. A source such as
`pdf_first_page_caption` is a caption, not full PDF extraction. Available ordinals run from zero
through `fragmentCount - 1`. `get_fragment` retains its 2,500-character bound and truncation flag.
Fragment availability is checked when each response is built and is not part of the outline snapshot.
Native notes report `textSource.status: "inline"` and `field: "title"`.
