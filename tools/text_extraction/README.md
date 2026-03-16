# Text Extraction

This is a small ad-hoc HTTP wrapper around [Marker](https://github.com/datalab-to/marker) for converting uploaded files to markdown.

It is intended for burst use:

- start it when you need to process a batch
- run it locally or on a short-lived VPS
- keep it bound to `127.0.0.1`
- access it over SSH port forwarding

## What It Does

- accepts multipart file uploads at `POST /convert`
- returns markdown and Marker metadata as JSON
- loads Marker models once when the service starts
- uses a fixed extraction policy chosen by the tool

## Start The Service

Requirements:

- `python3`
- `python3-venv`

From the repo root:

```bash
./tools/text_extraction/run.sh
```

On first run this creates `tools/text_extraction/.venv` and installs:

- `marker-pdf[full]`
- `fastapi`
- `uvicorn`
- `python-multipart`

By default the service listens on `127.0.0.1:8787`.

Optional environment variables:

- `TEXT_EXTRACTION_HOST`
- `TEXT_EXTRACTION_PORT`
- `TEXT_EXTRACTION_VENV_DIR`
- `PYTHON_BIN`
- `TORCH_DEVICE`
- `GOOGLE_API_KEY`

Examples:

```bash
TORCH_DEVICE=cpu ./tools/text_extraction/run.sh
```

```bash
TORCH_DEVICE=cuda TEXT_EXTRACTION_PORT=9000 ./tools/text_extraction/run.sh
```

The service uses a fixed extraction policy:

- `force_ocr=false`
- `paginate_output=true`
- `use_llm=true` only when `GOOGLE_API_KEY` is present in the environment at startup

## Access Over SSH

If the service is running on `my-host`:

```bash
ssh -L 8787:127.0.0.1:8787 my-host
```

Then use `http://127.0.0.1:8787` locally as if the service were running on your laptop.

## Convert A File

Example upload request:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  http://127.0.0.1:8787/convert
```

Print only the markdown:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  http://127.0.0.1:8787/convert \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["markdown"])'
```

## Endpoints

- `GET /`
- `GET /healthz`
- `POST /convert`

Interactive API docs are available at `http://127.0.0.1:8787/docs`.
