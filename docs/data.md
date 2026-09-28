# Data

TODO: Discussion of various data formats.

## Data directory

Each user lives under `user_<user_id>` in the configured data directory. In addition to the user and item logs, derived AI/search artifacts are stored alongside the user's data:

- `text/<first-two-item-id-chars>/<item_id>_text` is the item's local text: extracted Markdown for a PDF, the image description (JSON) for an image, or a copy of the original for a Markdown or plain text item. `<item_id>_manifest.json` describes it.
- `text/<first-two-item-id-chars>/<item_id>_geo.json` and `<item_id>_geo_manifest.json` hold an image's location lookup, when location lookup is configured.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments.jsonl` contains the searchable fragments built from the local text.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments_manifest.json` describes the fragment build.
- `fragments/<first-two-item-id-chars>/<item_id>/index_receipt.json` records which fragments were last committed to the content index.
- `indexes/document_fragments_tantivy/` is the content search index: document text and image-derived captions, tags, OCR, locations, and dates.
- `indexes/item_titles_tantivy/` is the title search index.
- `indexes/*.tmp/` directories are used while `rebuild-search-index` runs.
- `rebuild_search_index_checkpoint.json` records resumable `rebuild-search-index` progress and is removed after a successful rebuild.
- `search_status.json` may exist in older installations. It is no longer used and can be deleted.

All of these are derived from the items and their original files, and are regenerated automatically when missing. Index changes are committed in batches at most every 10 minutes, so search can lag behind edits and new content by that long. Originals never change after upload, so existing local text is always treated as correct and is never re-checked against its original.

### Deleting derived files

Stop the web server before deleting or editing these files. On the next start, Infumap notices what is missing or changed, removes stale search entries, and regenerates in the background. Progress is shown on the `Search processing` page under Queries.

| Delete | What happens | Why you might |
| --- | --- | --- |
| A PDF's or image's `_text` and `_manifest.json` | Extraction runs again with the current GPU tools; fragments and search entries are rebuilt. The item has no searchable content until then. For an image, the location lookup is also repeated. | Get better output from upgraded GPU tools, or retry a bad result. |
| A Markdown or text item's `_text` and `_manifest.json` | The local copy is recreated from the original file. | Discard manual edits to the copy. |
| `_geo.json` / `_geo_manifest.json` | The location lookup is repeated, using location service quota. | Refresh location results. |
| An item's `fragments/` directory | Fragments are rebuilt from the local text without the GPU, except PDFs whose only content was a first-page caption. | Rarely needed; repairs damaged fragment files. |
| An `index_receipt.json` | The item is recommitted to the content index at startup. | Never needed. |
| `indexes/document_fragments_tantivy/` or `indexes/item_titles_tantivy/` | Rebuilt at startup from existing fragments and titles. No GPU work is repeated. | Repair a damaged index. `rebuild-search-index` does the same and also compacts the index. |

You can also edit a `_text` file instead of deleting it (image descriptions are JSON; keep them valid). On the next start the item's fragments and search entries are rebuilt from your edited text.

### Reprocessing after upgrading GPU tools

Upgrading GPU tools does not change existing output. Only items processed afterwards use the new version. Reprocessing existing items is manual and selective:

- While the server runs, `infumap reprocess --id <item_id>` redoes one item. It deletes the item's local text and fragments, removes its old search entries with the next index batch, and queues it again. Its location lookup is kept unless the server restarts before the item is re-extracted.
- For many items, stop the server, delete the `_text` and `_manifest.json` files of the PDFs and images you want redone, and start it again (see the table above).

Each reprocessed item costs a full GPU request again, and a large batch can keep GPU tools busy for a long time. Until an item is re-extracted, its content is not searchable, although its title still is. Manual edits to its local text are lost. Bulk-deleting image text also repeats their location lookups. After a large batch has finished, running `rebuild-search-index` with the server stopped compacts the content index.

Older installations may still contain `indexes/fragments.sqlite3` or `indexes/fragments.sqlite3.tmp`. Infumap no longer reads these legacy semantic-search databases, so they can be deleted.

## Object Files
