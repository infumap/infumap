# GPU Services

This folder contains the three GPU-backed HTTP tools plus a shared HTTP gateway:

- `gateway`
- `image_tagging`
- `text_embedding`
- `text_extraction`

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

The combined launcher keeps each service independent:

- each child service still uses its own `run.sh` for setup and local supervision
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
