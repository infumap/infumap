# Data

TODO: Discussion of various data formats.

## Data directory

Each user lives under `user_<user_id>` in the configured data directory. In addition to the user and item logs, derived AI/search artifacts are stored alongside the user's data:

- `text/<first-two-item-id-chars>/<item_id>_text` is the item's local text: extracted Markdown for a PDF, the image description (JSON) for an image, or a copy of the original for a Markdown or plain text item. `<item_id>_manifest.json` describes it. Local text is trusted to reflect the original and is never re-checked against it; delete it (or reprocess the item) to regenerate it.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments.jsonl` contains derived fragment records.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments_manifest.json` describes the fragment build.
- `fragments/<first-two-item-id-chars>/<item_id>/index_receipt.json` records which fragments were last committed to the content index. It is written automatically and never needs editing.
- `indexes/document_fragments_tantivy/` is the current text-fragment lexical index used by full-user search, including document text and image-derived captions, tags, OCR, locations, and dates.
- `indexes/document_fragments_tantivy.tmp/` is the temp directory used while rebuilding the text-fragment lexical index.
- `indexes/item_titles_tantivy/` is the current item-title lexical index used by full-user search.
- `indexes/item_titles_tantivy.tmp/` is the temp directory used while rebuilding the item-title lexical index.
- `rebuild_search_index_checkpoint.json` records resumable `rebuild-search-index` progress and is removed after a successful rebuild.
- `search_status.json` may exist in older installations. It is no longer read or written and can be deleted; the search status pages under the Queries page are computed from live processing activity.

Fragment files and search indexes are derived data. They can be deleted and regenerated from the source items and extraction/tagging artifacts.

Older installations may still contain `indexes/fragments.sqlite3` or `indexes/fragments.sqlite3.tmp`. Infumap no longer reads these legacy semantic-search databases, so they can be deleted.

## Object Files
