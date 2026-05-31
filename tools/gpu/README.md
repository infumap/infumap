# GPU Services

This folder contains the three HTTP tools plus a shared HTTP gateway:

- `gateway`
- `image_extract`
- `text_embed`
- `pdf_extract`

The `image_extract`, `text_embed`, `pdf_extract`, and `gateway`
launchers require Python 3.10 through 3.13 because the pinned API and ML
dependencies do not install reliably on Python 3.9 or 3.14. By default they
reuse a valid service `.venv`, then try common versioned `python3.x`
executables, Homebrew Python installs, and common macOS install locations before
plain `python3`. Set `PYTHON_BIN=/path/to/python3.13` to force a specific
interpreter.

To start all three together from the repo root:

```bash
./tools/gpu/run.sh
```

By default the gateway listens on `127.0.0.1:8787` and forwards:

- `/gpu-tools` as the discovery endpoint for Infumap web
- `/image-extract` to the image extract service
- `/image-extract-caption-only` to the image extract service
- `/pdf-extract-caption-only` to the image extract service
- `/text-embed` to the text embed service
- `/pdf-extract` to the PDF extract service
- `/pdf-extract/jobs` as the gateway-owned async PDF extraction job API

The child services keep their own defaults:

- `image_extract`: `127.0.0.1:8788`
- `text_embed`: `127.0.0.1:8789`
- `pdf_extract`: `127.0.0.1:8790`

Hugging Face, llama.cpp, PyTorch, Transformers, and Marker downloads use their
standard library cache locations, such as `~/.cache/huggingface` and
`~/.cache/torch`.

`image_extract` defaults to
`unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf`. Set
`IMAGE_TAGGING_MODEL=<huggingface-repo>:<gguf-file>` or pass that selector as
the first `image_extract/run.sh` argument to select another model. You can also
use `IMAGE_TAGGING_MODEL_REPO`, `IMAGE_TAGGING_MODEL_FILE`, and
`IMAGE_TAGGING_MMPROJ_FILE` for separate fields.

Note: `tools/gpu/text_embed` defaults to
`Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` with `llama-server --embedding`. It
requests GPU layers on NVIDIA and macOS hosts by default. Set
`TEXT_EMBEDDING_LLAMA_NGL=0` to force CPU execution.

The combined launcher keeps each service independent:

- each child service uses its own `run.sh` for setup and local supervision
- the gateway uses its own `run.sh`
- the top-level launcher monitors all child launchers and restarts a service if its launcher exits
- requests sent through the gateway to image/PDF extraction endpoints are
  serialized by a global GPU lock so only one heavy forwarded endpoint request
  runs at a time; `/text-embed` bypasses this lock so search/query embedding can
  run in parallel
- gateway global-lock waits are bounded by `GPU_GATEWAY_LOCK_WAIT_TIMEOUT_SECS`
  and return HTTP 503 when the lock stays busy too long
- the gateway lock is leased; if a holder is wedged past
  `GPU_GATEWAY_LOCK_LEASE_SECS` (default 1 hour), a later request may take over
  instead of letting one stale request block all GPU work indefinitely
- gateway upstream read/write timeouts are 30 minutes by default, with a 4 hour
  read/write timeout for `/pdf-extract`
- the gateway also exposes async PDF extraction jobs for web-background use:
  `POST /pdf-extract/jobs`, `GET /pdf-extract/jobs/{job_id}`, and
  `GET /pdf-extract/jobs/{job_id}/result`; the gateway holds the global GPU lock
  while each async job calls the PDF extract service, and uses a separate
  async-job upstream timeout defaulting to 24 hours
- child image extract and PDF extract services also bound their internal
  worker-slot waits with `IMAGE_TAGGING_WORKER_SLOT_WAIT_TIMEOUT_SECS` and
  `TEXT_EXTRACTION_WORKER_SLOT_WAIT_TIMEOUT_SECS`
- PDF extract has a per-PDF conversion watchdog
  (`TEXT_EXTRACTION_CONVERSION_TIMEOUT_SECS`, default 1 hour); a timed-out PDF is
  treated as a terminal document failure and the supervised service process
  restarts to clear stuck native worker state
- PDF extract and the image-based PDF caption fallback return structured HTTP
  422 responses with `error_code="pdf_password_required"` for
  password-protected PDFs, allowing Infumap to store a terminal blocked
  extraction status without fragment or indexing follow-up

Optional environment variables:

- `GPU_RESTART_DELAY_SECS`
- `GPU_GATEWAY_HOST`
- `GPU_GATEWAY_PORT`
- `GPU_GATEWAY_VENV_DIR`
- `GPU_GATEWAY_RESTART_DELAY_SECS`
- `GPU_GATEWAY_LOCK_WAIT_TIMEOUT_SECS`
- `GPU_GATEWAY_LOCK_LEASE_SECS`
- `GPU_GATEWAY_PDF_EXTRACT_JOB_UPSTREAM_TIMEOUT_SECS`
- `GPU_GATEWAY_PDF_EXTRACT_JOB_RESULT_RETENTION_SECS`
- `GPU_IMAGE_EXTRACT_UPSTREAM_URL`
- `GPU_TEXT_EMBED_UPSTREAM_URL`
- `GPU_PDF_EXTRACT_UPSTREAM_URL`
- `IMAGE_TAGGING_WORKER_SLOT_WAIT_TIMEOUT_SECS`
- `TEXT_EXTRACTION_WORKER_SLOT_WAIT_TIMEOUT_SECS`
- `TEXT_EXTRACTION_CONVERSION_TIMEOUT_SECS`
- all service-specific `IMAGE_TAGGING_*`, `TEXT_EMBEDDING_*`, and `TEXT_EXTRACTION_*` variables
