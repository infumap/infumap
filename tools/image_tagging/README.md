# Image Tagging

This is a small ad-hoc HTTP wrapper around a swappable local image-tagging
backend. The default built-in backend uses Qwen 3.5 9B for search-oriented
image understanding and document-candidate detection, and the service can also
load alternate local backends for model experiments while keeping the same HTTP
API.

It is intended for burst use:

- start it when you need to process a batch
- run it locally or on a short-lived GPU VPS
- keep it bound to `127.0.0.1`
- access it over SSH port forwarding

## What It Does

- accepts multipart image uploads at `POST /tag`
- returns OCR, detailed caption, object detections, normalized tags, and
  document-candidate heuristics as JSON
- loads the selected backend once when the service starts
- supports built-in Qwen and Florence backends plus custom Python backends

## Start The Service

Requirements:

- `python3`
- `python3-venv`

From the repo root:

```bash
./tools/image_tagging/run.sh
```

On first run this creates `tools/image_tagging/.venv` and installs:

- `torch`
- `fastapi`
- `uvicorn`
- `python-multipart`
- `Pillow`

The launcher installs backend-specific packages automatically:

- built-in `qwen35`: `transformers`, `accelerate`, `bitsandbytes`
- built-in `qwen35-35b`: `transformers`, `accelerate`, `bitsandbytes`
- built-in `florence`: `transformers`, `timm`, `einops`
- custom backends: packages listed in a top-level `PIP_REQUIREMENTS = [...]`
  literal inside the backend file/module
- ad hoc experiments: extra packages from `IMAGE_TAGGING_EXTRA_PIP_PACKAGES`

By default the service listens on `127.0.0.1:8788` and uses the built-in
`qwen35` backend with `Qwen/Qwen3.5-9B`.

If you just want the default high-quality local setup, run:

```bash
./tools/image_tagging/run.sh
```

That path is intended for a CUDA GPU with roughly 24 GiB or more of VRAM.
For a 32 GiB card, `qwen35` is the safer default in this native Transformers
backend. The `Qwen/Qwen3.5-27B` and `qwen35-35b` variants can run out of memory
even with 4-bit quantization here, despite fitting in leaner runtimes such as
GGUF/llama.cpp.

Optional environment variables:

- `IMAGE_TAGGING_HOST`
- `IMAGE_TAGGING_PORT`
- `IMAGE_TAGGING_VENV_DIR`
- `IMAGE_TAGGING_BACKEND`
- `IMAGE_TAGGING_MODEL_ID`
- `IMAGE_TAGGING_TRANSFORMERS_VERSION`
- `IMAGE_TAGGING_EXTRA_PIP_PACKAGES`
- `IMAGE_TAGGING_MAX_CONCURRENCY`
- `IMAGE_TAGGING_QWEN_DEVICE_MAP`
- `PYTHON_BIN`
- `TORCH_DEVICE`

Examples:

```bash
TORCH_DEVICE=cpu ./tools/image_tagging/run.sh
```

```bash
TORCH_DEVICE=cuda IMAGE_TAGGING_PORT=9001 ./tools/image_tagging/run.sh
```

Try the larger Qwen 35B variant explicitly:

```bash
IMAGE_TAGGING_BACKEND=qwen35-35b ./tools/image_tagging/run.sh
```

Try the denser Qwen 27B checkpoint explicitly:

```bash
IMAGE_TAGGING_BACKEND=qwen35 IMAGE_TAGGING_MODEL_ID=Qwen/Qwen3.5-27B ./tools/image_tagging/run.sh
```

If a fresh machine hits a Qwen class import error during startup, force a newer
Transformers release and rerun:

```bash
IMAGE_TAGGING_TRANSFORMERS_VERSION=5.3.0 ./tools/image_tagging/run.sh
```

If a Qwen startup fails because `device_map="auto"` wants to spill modules to
CPU or disk, the built-in backend now prefers single-GPU placement by default.
You can still opt back into Hugging Face auto placement with:

```bash
IMAGE_TAGGING_QWEN_DEVICE_MAP=auto ./tools/image_tagging/run.sh
```

Use a custom backend file:

```bash
IMAGE_TAGGING_BACKEND='file:backend_template.py' ./tools/image_tagging/run.sh
```

Try a different local model with a custom backend file:

```bash
IMAGE_TAGGING_BACKEND='file:/path/to/qwen_backend.py' \
IMAGE_TAGGING_MODEL_ID='Qwen/your-model-id' \
./tools/image_tagging/run.sh
```

Custom backend contract:

- `IMAGE_TAGGING_BACKEND=qwen35` uses the built-in Qwen 9B backend
- `IMAGE_TAGGING_BACKEND=qwen35-35b` uses the built-in Qwen 35B backend
- `IMAGE_TAGGING_BACKEND=florence` uses the built-in Florence backend
- `IMAGE_TAGGING_BACKEND=module:your_python.import.path` imports a module
- `IMAGE_TAGGING_BACKEND=file:/abs/path/to/backend.py` loads a backend file
- a custom backend must expose either `load_backend(config)` or `Backend(config)`
- a custom backend can declare `PIP_REQUIREMENTS = ["pkg", "otherpkg==1.2.3"]`
  so `run.sh` installs what that backend needs automatically
- the returned object must implement `startup()`, `shutdown()`, `health_ready()`,
  `tag_image_file(...)`, and `name`
- keep optional heavy imports inside `startup()` so bootstrap-time requirement
  discovery does not need the model packages preinstalled

See [backend_template.py](./backend_template.py)
for a minimal example backend you can copy and adapt to a different local model.

## Access Over SSH

If the service is running on `my-host`:

```bash
ssh -L 8788:127.0.0.1:8788 my-host
```

Then use `http://127.0.0.1:8788` locally as if the service were running on
your laptop.

## Tag An Image

Example upload request:

```bash
curl -sS \
  -F "file=@/path/to/photo.jpg" \
  http://127.0.0.1:8788/tag
```

## Supported Image Types

- `image/jpeg`
- `image/png`
- `image/webp`
- `image/tiff`

Animated images and vector images are not supported.

## Endpoints

- `GET /`
- `GET /healthz`
- `POST /tag`

Interactive API docs are available at `http://127.0.0.1:8788/docs`.
