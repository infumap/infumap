# Infumap chat tools

Chats with the Infumap data source enabled have two built-in read-only tools:

- `lexical_search`: find items using their titles and indexed document text.
- `get_fragment`: read any item a fragment at a time: documents, images, notes, and pages, tables and
  composites.

Both are designed to keep tool results small, because results stay in the chat transcript and weaker
models have little context to spare. Items are identified everywhere by a `link`, `infumap://<id>`: tool
results give it, tool arguments take it, and the model copies it into its answer as a citation.

Arguments also accept what models commonly send instead: a bare id, a whole Markdown link, a link in
quotes or brackets or followed by punctuation, whole numbers as strings, and near-miss names such as
`query` for `text` or `ordinal` for `fragmentOrdinal`. A value that still cannot be used is an error,
not ignored.

Tool results longer than 500 characters are kept whole for the turn that produced them. When the
next question arrives, they are replaced in the transcript by a short stub with a one-line summary,
and the model calls the tool again if a follow-up needs the content. Each result is replaced once and
identically from then on, so every turn still reuses the provider's prompt cache up to the previous
turn's results.

## Scopes

A chat request may name a [scope](scopes.md) with `scopeId`. The scope is resolved once when the run
starts; an unknown or deleted scope fails the request rather than widening it. Every tool then
applies it:

- `lexical_search` returns only items in the scope. A `within` argument narrows it further. A result
  whose listing container is outside the scope, such as an include root itself, has no links in its
  location.
- `get_fragment` reports an item outside the scope as not found. A container's fragments omit
  children and attachments outside the scope, and a link whose target is outside it is shown as
  `(unavailable link)`.

Search locations and fragment breadcrumbs are not filtered. Every ancestor of an excluded item is itself
excluded, so they never reveal excluded content; they can only name containers above an include root,
and a parent outside the scope is named without a link. The system prompt names the active scope, so
the model does not mistake an out-of-scope item for a missing one. Context items the user attaches to
the chat are sent as given, regardless of scope. A scope has no effect when the Infumap data source is
disabled.

## Searching

```json
{ "text": "acme onboarding", "within": "<optional page or table link>", "numResults": 8, "pageNum": 1 }
```

`text` is required; `numResults` defaults to 8 and accepts 1–20.

A result matches any of the words, compared after lowercasing and reducing them to their English
stem, so "staying" matches "stay" and "hotels" matches "hotel". Text in other languages goes through
the same rules, so a word always matches itself exactly. Words that no item contains are ignored. Results matching more of the words come first: items
matching all of them, then those matching one fewer, and so on, each group ranked as usual. Words are
counted per document fragment, or per item title entry, which also holds the parent's title and the
item's attachments. So a note matching only one rare word cannot outrank one matching several, and
pages of results do not overlap across groups. Scores are scaled by the share of words matched. The
search box in the UI ranks results the same way.

Each result is one line of text:

```json
{
  "results": [
    "root › travel › [malaysia](infumap://<page id>) › [composite](infumap://<id>) › [Cocktails at Four Seasons](infumap://<id>)",
    "Home › Projects › [Tasks](infumap://<table id>) (fragment 4) › [Acme onboarding](infumap://<id>) | Active | 2026-01-03",
    "Home › [Reports](infumap://<page id>) › [annual.pdf](infumap://<id>) (file, application/pdf, 312 fragments) — fragment 200: …a drink stall opened in FY2025…"
  ],
  "hasMore": false
}
```

- The line starts with the result's location, outermost first. Titles above the page or table whose
  fragments list the result are plain text. From that container down, every item is a link that
  `get_fragment` can read: the container, any composite or item the result belongs to, and the
  result itself. Attachments and composite members belong to the item or composite they are part of,
  so a table cell's container is its row's table. A page or table result is listed by its parent.
  A group comes after its page when the result, or the item holding it, is one of its members.
- `(fragment N)` after the container is the fragment listing the result, given only when it is past
  the first.
- A result on a calendar page starts with its day as the page lists it, such as
  `2026-01-03 Sat: [dentist](infumap://<id>)`. For a composite member or an attachment, that is the
  day of the item holding it.
- Composites have no titles and are labelled `composite`; other untitled items are `untitled <type>`.
  Location titles are cut at 60 characters.
- The result itself is its label as in container fragments, such as `(page, 12 items)` or
  `(file, application/pdf, 312 fragments)`. A note is its text, cut at a sentence or word near 160
  characters and followed by `(note, N fragments)` when cut.
- A table row, or a cell of one, is shown as the whole row with its cells, cut at 300 characters. A
  row and its cell give the same line, which is listed once.
- `— fragment N: …` ends a result whose document text matched: its best matching sentence, cut to
  about 220 characters around the first query word, and the fragment holding it, for `get_fragment`.
  Only files, text items and images have document text; notes, pages and tables match by their titles.
  Page numbers are left out; `get_fragment` gives them when the passage is read.

Containers are rendered from the live database when the search runs, while the search index can lag
edits by several minutes. A moved item links its new container, and a deleted item links none.

## Reading

```json
{ "link": "infumap://<id>", "fragmentOrdinal": 0, "count": 1, "version": "<optional>" }
```

`link` is required; a link item reads as its target. `fragmentOrdinal` defaults to 0, and `count` returns 1–3 consecutive fragments. The response depends on the item:

| Item | `sourceKind` | Fragments |
| --- | --- | --- |
| Page, table, composite, group | `container` | Its items as lines of text, built on demand (below). |
| Note | `note` | Its text, built on demand (below). |
| File, text, image | stored kind, e.g. `pdf_markdown` | Stored when the document was processed; each is cut at 2,500 characters with `textTruncated`. |

Other items, such as ratings and dividers, have no readable text.

A group is not an item: it is the `groupId` shared by two or more children of a page. Its link is
`infumap://<groupId>`, and it reads with `itemType` and `title` both `group`: its members as units,
laid out as its page lays them out, under a header linking the page. A group id left on one child,
or on one child the scope leaves readable, is not a group and is not found. The same link opened in
the UI, from the URL bar or a note, shows the group's page with the group highlighted for three
seconds, and the URL becomes the page's.

```json
{
  "link": "infumap://<id>", "itemType": "table", "title": "Tasks",
  "sourceKind": "container", "fragmentCount": 11, "version": "3f9a0c2e",
  "fragments": [{ "fragmentOrdinal": 0, "text": "…" }],
  "nextFragmentOrdinal": 1
}
```

- `title` is a label of at most 80 characters, not a note's full text.
- `nextFragmentOrdinal` is present while fragments remain. Following it until it is absent reads the
  whole item.
- `version` (containers and notes) changes when the item's rendered text changes. When the request
  passes a different `version`, the response adds `changed: true`, since ordinals may have moved.
- Stored fragments also carry `pageStart` and `pageEnd` when known. A file still being processed
  reports "This item has no readable text yet."

### Container fragments

Containers change whenever the user edits them, so their fragments are rendered from the live
database on each call and never stored. Each fragment starts with a header:

```
[Tasks](infumap://<id>) (table) in Home › Projects › [Acme](infumap://<id>) · fragment 4 of 0–10 · rows 81–100 of 213
Columns: Name | Status | Due
```

The header links the container and its parent. Table fragments add their row range and repeat the
column names. The body is at most 2,500 characters, made of units that are never split across
fragments unless one alone is too long: a top-level item with its attachments, a table row, a
composite, or an explicit group.

How items appear:

- Notes of up to 80 characters are links: `- [Buy milk](infumap://<id>)`, followed by `<url>` for
  each URL in the note. Longer notes show a 40-character link label, then their text with URLs as Markdown links,
  cut at 600 characters with `(truncated; full text in N fragments)`.
- Child pages and tables are one line with their item or row count, and tables their column names.
  They are read by their own link, so rendering never descends into them.
- Composites are expanded inline, with members indented beneath them. A composite linked inside
  itself is shown once, then as `(composite, shown above)`.
- Files, text items and images show their type, MIME type and stored fragment count.
- Attachments follow their item on an `attached:` line.
- Links render their target and link to it.

How containers are laid out:

- Tables, and pages arranged as tables, show one row per line: `[row](infumap://<id>) | cell | cell`.
  Empty cells are blank, trailing empty cells are dropped, `|` in cell text is escaped, and cells are
  cut at 200 characters with a `[more](infumap://<cell id>)` link. Columns hidden in the UI are
  included.
- Document pages render notes as Markdown, with headings, bullets, numbering, indents and code
  blocks, and without a link per note. Long notes are split across fragments rather than cut.
- Spatial pages list children top to bottom, then left to right, each starting with its position
  and size in blocks: `- @14,1 6×4.5 [photo.jpg](infumap://<id>) (image, 2 fragments)`. A line after
  the header gives the page's area and says how to read them, since the model is left to work out
  what sits next to what. Heights follow the UI where stored data sets them: pages and images from
  their width and aspect, tables and explicit-height notes from their stored height, ratings and
  one-line items as 1. A height set by text wrapping, as for notes, files and composites, is `?`.
  Composite members and attachments have no geometry of their own.
- On every kind of page, the members of a group with two or more members are listed together
  where its first member would be, under `[group](infumap://<groupId>) (group, N items)`: indented
  beneath it, or for document pages, following it.
- Calendar pages list children by date with a `2026-01-03 Sat:` prefix, or
  `2026-01-01 Thu – 2026-01-03 Sat:` for an item spanning days. The calendar places items by day, so
  no time of day is given; the weekday saves the model working it out. Dates are taken as stored,
  without converting between time zones.
- Other pages use their stored order, or title order when the container sorts by title (document
  pages excepted), with unresolved links last.

Containers with more than 50,000 placements or nesting deeper than 64 levels return an error rather
than claiming complete coverage.

### Note fragments

A note's fragments are its text, with URL annotations as Markdown links, split into pieces of at
most 2,500 characters. Each cut is the last one in the second half of the budget after a blank line,
else a line break, else a sentence, else a word, and never inside a link. Any non-empty note has at
least fragment 0.
