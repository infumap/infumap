# Data

TODO: Discussion of various data formats.

## Data directory

Each user lives under `user_<user_id>` in the configured data directory. In addition to the user and item logs, derived AI/search artifacts are stored alongside the user's data:

- `fragments/<first-two-item-id-chars>/<item_id>/fragments.jsonl` contains derived fragment records.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments_manifest.json` describes the fragment build.
- `indexes/document_fragments_tantivy/` is the current document-fragment lexical index used by full-user search.
- `indexes/document_fragments_tantivy.tmp/` is the temp directory used while rebuilding the document-fragment lexical index.
- `indexes/item_titles_tantivy/` is the current item-title lexical index used by full-user search.
- `indexes/fragments.sqlite3` is the current fragment vector index used by semantic search.
- `indexes/fragments.sqlite3.tmp` is the resumable temp database used by `infumap embed --continue`.

Fragment files and search indexes are derived data. They can be deleted and regenerated from the source items and extraction/tagging artifacts.

## Object Files
