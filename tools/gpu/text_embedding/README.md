# Text Embedding

This service exposes batched text embeddings over HTTP using Python
`fastembed`.

It is intentionally configured to match Infumap's embedded Rust embedding path:

- same underlying ONNX repo used by Rust fastembed: `Xenova/bge-base-en-v1.5`
- same ONNX file: `onnx/model.onnx`
- same pooling: `CLS`
- same normalization: enabled
- same raw text behavior: plain `embed()` calls, with no query/passage prefix
  rewriting

That means a batch sent to this service should produce vectors compatible with
the embedded Rust `fastembed` path used by the `embed` CLI when ONNX support is
compiled in.

## What It Does

- accepts JSON batches at `POST /embed`
- loads the embedding model once at startup
- returns one embedding per input in request order
- caches the model files under `tools/gpu/text_embedding/models` by default

## Default Layout

By default:

- the HTTP service listens on `127.0.0.1:8789`
- model files live under `tools/gpu/text_embedding/models`
- the launcher creates or reuses `tools/gpu/text_embedding/.venv`
- the launcher installs Python `fastembed-gpu`, `fastapi`, and `uvicorn` on
  GPU hosts by default, and otherwise falls back to `fastembed`

## Start The Service

Requirements:

- `python3`
- `python3-venv`

From the repo root:

```bash
./tools/gpu/text_embedding/run.sh
```

On first run that command:

1. creates `tools/gpu/text_embedding/.venv`
2. installs Python dependencies
3. starts the FastAPI service
4. downloads the compatible model into the local model cache on first startup

## Important Environment Variables

- `TEXT_EMBEDDING_HOST`
- `TEXT_EMBEDDING_PORT`
- `TEXT_EMBEDDING_VENV_DIR`
- `TEXT_EMBEDDING_MODELS_DIR`
- `TEXT_EMBEDDING_MAX_BATCH_ITEMS`
- `TEXT_EMBEDDING_MAX_TEXT_CHARS`
- `TEXT_EMBEDDING_MAX_CONCURRENCY`
- `TEXT_EMBEDDING_RESTART_DELAY_SECS`
- `TEXT_EMBEDDING_PROVIDERS`
- `TEXT_EMBEDDING_FASTEMBED_PACKAGE`

Notes:

- The service intentionally registers and uses the exact model
  `Xenova/bge-base-en-v1.5` at startup. This is important because in the
  Python FastEmbed package currently used by this tool, the built-in public
  alias `BAAI/bge-base-en-v1.5` resolves to a quantized Qdrant artifact
  instead of the Xenova ONNX file that Rust fastembed uses for
  `EmbeddingModel::BGEBaseENV15`.
- `TEXT_EMBEDDING_PROVIDERS` is optional and can be used to force a specific
  ONNX Runtime provider list such as `CUDAExecutionProvider,CPUExecutionProvider`.
- On hosts where `nvidia-smi` is available, the launcher now defaults to
  `fastembed-gpu` and `TEXT_EMBEDDING_PROVIDERS=CUDAExecutionProvider,CPUExecutionProvider`.
- `TEXT_EMBEDDING_FASTEMBED_PACKAGE` can still be overridden explicitly if you
  want to force `fastembed` or a different compatible package choice.
- `TEXT_EMBEDDING_AUTO_GPU_FALLBACK` defaults to `1`. If CUDA provider startup
  fails, the service logs the problem and retries with `CPUExecutionProvider`
  so the endpoint still comes up.

## Example Requests

Batch of fragments:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "inputs": [
      {"id": "frag-1", "text": "Document: Example.pdf\n\nThis is the first fragment."},
      {"id": "frag-2", "text": "Document: Example.pdf\n\nThis is the second fragment."}
    ]
  }' \
  http://127.0.0.1:8789/embed
```

Single query text with the same embedding path:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "inputs": [
      {"id": "query-1", "text": "mandarin oriental kuala lumpur booking details"}
    ]
  }' \
  http://127.0.0.1:8789/embed
```

## Endpoints

- `GET /`
- `GET /healthz`
- `POST /embed`

Interactive API docs are available at `http://127.0.0.1:8789/docs`.

## Response Shape

`POST /embed` returns:

- `model`
- `compatible_with_rust_model`
- `dimensions`
- `normalized`
- `count`
- `duration_ms`
- `results`

Each result contains:

- `index`
- `id`
- `embedding`

## Notes

- The service validates that the batch is non-empty and caps batch size and
  per-input text length.
- The `/embed` endpoint is generic text, not fragment-specific. A search query
  is just a one-item batch.
- Compatibility here means the service is configured to match the current
  embedded Rust `fastembed` path. If the Rust path changes model, pooling,
  normalization, or query-prefix behavior later, this service should be updated
  in lockstep.
- That compatibility guarantee is about model choice and embedding semantics.
  GPU vs CPU execution may still introduce small floating-point differences, so
  use the `embed` CLI comparison mode if you want to verify drift on a
  particular machine.
