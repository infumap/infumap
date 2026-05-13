# GPU Services

This folder contains the three HTTP tools plus a shared HTTP gateway:

- `gateway`
- `image_tagging`
- `text_embedding`
- `text_extraction`

The `image_tagging`, `text_embedding`, `text_extraction`, and `gateway`
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

- `/image-extract` to the image tagging service
- `/text-embed` to the text embedding service
- `/pdf-extract` to the text extraction service

The gateway also keeps legacy aliases for existing callers:

- `/tag`
- `/embed`
- `/convert`

The child services keep their own defaults:

- `image_tagging`: `127.0.0.1:8788`
- `text_embedding`: `127.0.0.1:8789`
- `text_extraction`: `127.0.0.1:8790`

Hugging Face, llama.cpp, PyTorch, Transformers, and Marker downloads use their
standard library cache locations, such as `~/.cache/huggingface` and
`~/.cache/torch`.

`image_tagging` defaults to
`unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf`. Set
`IMAGE_TAGGING_MODEL=<huggingface-repo>:<gguf-file>` or pass that selector as
the first `image_tagging/run.sh` argument to select another model. You can also
use `IMAGE_TAGGING_MODEL_REPO`, `IMAGE_TAGGING_MODEL_FILE`, and
`IMAGE_TAGGING_MMPROJ_FILE` for separate fields.

Note: `tools/gpu/text_embedding` defaults to
`Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0` with `llama-server --embedding`. It
requests GPU layers on NVIDIA and macOS hosts by default. Set
`TEXT_EMBEDDING_LLAMA_NGL=0` to force CPU execution.

The combined launcher keeps each service independent:

- each child service uses its own `run.sh` for setup and local supervision
- the gateway uses its own `run.sh`
- the top-level launcher monitors all child launchers and restarts a service if its launcher exits
- requests are not serialized globally across all endpoints

Optional environment variables:

- `GPU_RESTART_DELAY_SECS`
- `GPU_GATEWAY_HOST`
- `GPU_GATEWAY_PORT`
- `GPU_GATEWAY_VENV_DIR`
- `GPU_GATEWAY_RESTART_DELAY_SECS`
- `GPU_IMAGE_TAGGING_UPSTREAM_URL`
- `GPU_TEXT_EMBEDDING_UPSTREAM_URL`
- `GPU_TEXT_EXTRACTION_UPSTREAM_URL`
- all service-specific `IMAGE_TAGGING_*`, `TEXT_EMBEDDING_*`, and `TEXT_EXTRACTION_*` variables
