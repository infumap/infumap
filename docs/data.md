# Data

TODO: Discussion of various data formats.

## Data directory

Each user lives under `user_<user_id>` in the configured data directory. In addition to the user and item logs, derived AI/search artifacts are stored alongside the user's data:

- `fragments/<first-two-item-id-chars>/<item_id>/fragments.jsonl` contains derived fragment records.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments_manifest.json` describes the fragment build.
- `indexes/document_fragments_tantivy/` is the current text-fragment lexical index used by full-user search, including document text and image-derived captions, tags, OCR, locations, and dates.
- `indexes/document_fragments_tantivy.tmp/` is the temp directory used while rebuilding the text-fragment lexical index.
- `indexes/item_titles_tantivy/` is the current item-title lexical index used by full-user search.
- `indexes/item_titles_tantivy.tmp/` is the temp directory used while rebuilding the item-title lexical index.
- `rebuild_search_index_checkpoint.json` records resumable `rebuild-search-index` progress and is removed after a successful rebuild.
- `search_status.json` records items whose search fragments failed or are still pending. The web UI exposes these as virtual pages under the user's Queries page.

Fragment files and search indexes are derived data. They can be deleted and regenerated from the source items and extraction/tagging artifacts.

Older installations may still contain `indexes/fragments.sqlite3` or `indexes/fragments.sqlite3.tmp`. Infumap no longer reads these legacy semantic-search databases, so they can be deleted.

## Object Files
