# Data

TODO: Discussion of various data formats.

## Data directory

Each user lives under `user_<user_id>` in the configured data directory. In addition to the user and item logs, derived AI/search artifacts are stored alongside the user's data:

- `fragments/<first-two-item-id-chars>/<item_id>/fragments.jsonl` contains manually generated fragment records.
- `fragments/<first-two-item-id-chars>/<item_id>/fragments_manifest.json` describes the fragment build.
- `indexes/fragments.sqlite3` is the current fragment vector index used by semantic search.
- `indexes/fragments.sqlite3.tmp` is the resumable temp database used by `infumap embed --continue`.

Fragment files and vector indexes are derived data. They can be deleted and regenerated from the source items and extraction/tagging artifacts.

## Object Files
