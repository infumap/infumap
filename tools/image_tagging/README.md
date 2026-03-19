# Image Tagging

This is a small ad-hoc HTTP wrapper around Florence-2 for tagging uploaded
images. It runs OCR, detailed captioning, and object detection for every
supported image request and returns the full structured result as JSON.

It is intended for burst use:

- start it when you need to process a batch
- run it locally or on a short-lived GPU VPS
- keep it bound to `127.0.0.1`
- access it over SSH port forwarding

## What It Does

- accepts multipart image uploads at `POST /tag`
- returns OCR, detailed caption, object detections, normalized tags, and
  document-candidate heuristics as JSON
- loads Florence-2 once when the service starts
- uses a fixed tagging policy chosen by the tool

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
- `transformers`
- `fastapi`
- `uvicorn`
- `python-multipart`
- `Pillow`
- `timm`
- `einops`

By default the service listens on `127.0.0.1:8788` and uses
`microsoft/Florence-2-large-ft`.

Optional environment variables:

- `IMAGE_TAGGING_HOST`
- `IMAGE_TAGGING_PORT`
- `IMAGE_TAGGING_VENV_DIR`
- `IMAGE_TAGGING_MODEL_ID`
- `IMAGE_TAGGING_MAX_CONCURRENCY`
- `PYTHON_BIN`
- `TORCH_DEVICE`

Examples:

```bash
TORCH_DEVICE=cpu ./tools/image_tagging/run.sh
```

```bash
TORCH_DEVICE=cuda IMAGE_TAGGING_PORT=9001 ./tools/image_tagging/run.sh
```

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
