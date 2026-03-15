# Marker Service

This is a small ad-hoc HTTP wrapper around [Marker](https://github.com/datalab-to/marker) for converting uploaded files to markdown.

It is intended for burst use:

- start it when you need to process a batch
- run it locally or on a short-lived VPS
- keep it bound to `127.0.0.1`
- access it over SSH port forwarding

## What It Does

- accepts multipart file uploads at `POST /convert`
- returns markdown and Marker metadata as JSON
- also supports `POST /convert-path` for files already present on the machine running the service
- loads Marker models once when the service starts

## Start The Service

Requirements:

- `python3`
- `python3-venv`

From the repo root:

```bash
./tools/pdf_to_md/run.sh
```

On first run this creates `tools/pdf_to_md/.venv` and installs:

- `marker-pdf[full]`
- `fastapi`
- `uvicorn`
- `python-multipart`

By default the service listens on `127.0.0.1:8787`.

Optional environment variables:

- `MARKER_SERVICE_HOST`
- `MARKER_SERVICE_PORT`
- `MARKER_SERVICE_VENV_DIR`
- `PYTHON_BIN`
- `TORCH_DEVICE`
- `GOOGLE_API_KEY`

Examples:

```bash
TORCH_DEVICE=cpu ./tools/pdf_to_md/run.sh
```

```bash
TORCH_DEVICE=cuda MARKER_SERVICE_PORT=9000 ./tools/pdf_to_md/run.sh
```

If you want Marker to use its higher-quality LLM mode, set `GOOGLE_API_KEY` before starting the service and pass `use_llm=true` in the request.

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

Example with extra options:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  -F "force_ocr=true" \
  -F "paginate_output=true" \
  -F "use_llm=true" \
  http://127.0.0.1:8787/convert
```

Print only the markdown:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  http://127.0.0.1:8787/convert \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["markdown"])'
```

Convert a file already on the host:

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -d '{"filepath":"/path/to/document.pdf","force_ocr":false}' \
  http://127.0.0.1:8787/convert-path
```

## Endpoints

- `GET /`
- `GET /healthz`
- `POST /convert`
- `POST /convert-path`

Interactive API docs are available at `http://127.0.0.1:8787/docs`.
