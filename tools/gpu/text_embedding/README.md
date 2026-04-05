# Text Embedding

This service exposes batched text embeddings over HTTP using Python
`fastembed`.

It is intentionally configured to keep Infumap's embedding semantics stable:

- same underlying ONNX repo as the previous Rust fastembed path: `Xenova/bge-base-en-v1.5`
- same ONNX file: `onnx/model.onnx`
- same pooling: `CLS`
- same normalization: enabled
- same raw text behavior: plain `embed()` calls, with no query/passage prefix
  rewriting

That means a batch sent to this service should produce vectors compatible with
the embeddings Infumap has been using already, while moving execution fully out
to the external service.

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
- the launcher defaults to `TEXT_EMBEDDING_DEVICE=cpu`
- the launcher installs regular `fastembed` for CPU mode
- when `TEXT_EMBEDDING_DEVICE=gpu` is requested on an NVIDIA host, the launcher
  installs `fastembed-gpu`

## Start The Service

Requirements:

- `python3`
- `python3-venv`

From the repo root:

```bash
./tools/gpu/text_embedding/run.sh
```

To force GPU mode explicitly:

```bash
TEXT_EMBEDDING_DEVICE=gpu ./tools/gpu/text_embedding/run.sh
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
- `TEXT_EMBEDDING_DEVICE`
- `TEXT_EMBEDDING_MAX_BATCH_ITEMS`
- `TEXT_EMBEDDING_MAX_TEXT_CHARS`
- `TEXT_EMBEDDING_MAX_CONCURRENCY`
- `TEXT_EMBEDDING_RESTART_DELAY_SECS`

Notes:

- The service intentionally registers and uses the exact model
  `Xenova/bge-base-en-v1.5` at startup. This is important because in the
  Python FastEmbed package currently used by this tool, the built-in public
  alias `BAAI/bge-base-en-v1.5` resolves to a quantized Qdrant artifact
  instead of the Xenova ONNX file that Infumap has been matching historically.
- `TEXT_EMBEDDING_DEVICE` accepts `cpu` or `gpu`. The default is `cpu`.
- `TEXT_EMBEDDING_DEVICE=gpu` requests an accelerated ONNX Runtime provider.
  On NVIDIA Linux hosts that means CUDA. On macOS it prefers CoreML when the
  installed ONNX Runtime build exposes it.
- If you request `TEXT_EMBEDDING_DEVICE=gpu` on a machine without a usable
  accelerated provider, startup should fail rather than silently falling back
  to CPU.
- `TEXT_EMBEDDING_PROVIDERS` and `TEXT_EMBEDDING_FASTEMBED_PACKAGE` are still
  honored as advanced overrides when you need to force a particular runtime.
- On Linux NVIDIA hosts, the launcher now prepends the CUDA runtime libraries
  bundled in the venv to `LD_LIBRARY_PATH` before starting the service so
  ONNX Runtime can resolve `libcublas`, `libcudnn`, and related dependencies.
- On Linux NVIDIA hosts, the launcher also installs `onnxruntime-gpu[cuda,cudnn]`
  so the CUDA 12 / cuDNN 9 runtime expected by current ONNX Runtime GPU wheels
  is present inside the venv.

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

`GET /` and `GET /healthz` both report the configured, available, and active
ONNX providers, along with the requested `device`, so you can confirm whether
the service is actually on CPU or using acceleration.

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
- Compatibility here means the service is configured to match Infumap's current
  embedding model and semantics.
- GPU vs CPU execution may still introduce small floating-point differences.
