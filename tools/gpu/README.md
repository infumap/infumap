# GPU Services

This folder contains the three HTTP tools plus a shared HTTP gateway:

- `gateway`
- `image_tagging`
- `text_embedding`
- `text_extraction`

The service launchers require Python 3.10 through 3.13 because the pinned API
and ML dependencies do not install reliably on Python 3.9 or 3.14. By default
they reuse a valid service `.venv`, then try common versioned `python3.x`
executables, Homebrew Python installs, and common macOS install locations before
plain `python3`. Set `PYTHON_BIN=/path/to/python3.13` to force a specific
interpreter.

To start all three together from the repo root:

```bash
./tools/gpu/run.sh
```

By default the gateway listens on `127.0.0.1:8787` and forwards:

- `/tag` to the image tagging service
- `/embed` to the text embedding service
- `/convert` to the text extraction service

The child services keep their own defaults:

- `image_tagging`: `127.0.0.1:8788`
- `text_embedding`: `127.0.0.1:8789`
- `text_extraction`: `127.0.0.1:8790`

Hugging Face, FastEmbed, PyTorch, Transformers, and Marker downloads use their
standard library cache locations, such as `~/.cache/huggingface` and
`~/.cache/torch`.

Short model aliases live in `tools/gpu/model_aliases.json`. This registry
has a global `aliases` section plus a `tools` section for per-tool defaults and
compatibility. The launchers resolve it through `tools/gpu/resolve_model_alias.py`.

Note: `tools/gpu/text_embedding` defaults to CPU execution. Set
`TEXT_EMBEDDING_DEVICE=gpu` if you want that service to request acceleration.

The combined launcher keeps each service independent:

- each child service uses its own `run.sh` for setup and local supervision
- the gateway uses its own `run.sh`
- the top-level launcher monitors all child launchers and restarts a service if its launcher exits
- requests are not serialized globally across all endpoints

Optional environment variables:

- `GPU_MODEL_ALIAS_REGISTRY`
- `GPU_RESTART_DELAY_SECS`
- `GPU_GATEWAY_HOST`
- `GPU_GATEWAY_PORT`
- `GPU_GATEWAY_VENV_DIR`
- `GPU_GATEWAY_RESTART_DELAY_SECS`
- `GPU_IMAGE_TAGGING_UPSTREAM_URL`
- `GPU_TEXT_EMBEDDING_UPSTREAM_URL`
- `GPU_TEXT_EXTRACTION_UPSTREAM_URL`
- all service-specific `IMAGE_TAGGING_*`, `TEXT_EMBEDDING_*`, and `TEXT_EXTRACTION_*` variables
