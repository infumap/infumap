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

`run.sh` now supervises the `uvicorn` process. If the text extraction service crashes
(including a segfault), the script logs the exit and restarts it automatically after
a short delay. Pressing `Ctrl-C` still stops the supervisor cleanly.

Optional environment variables:

- `TEXT_EXTRACTION_HOST`
- `TEXT_EXTRACTION_PORT`
- `TEXT_EXTRACTION_VENV_DIR`
- `TEXT_EXTRACTION_RESTART_DELAY_SECS`
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

## Access Over VPN

If you bind the service to `0.0.0.0` and want to reach it directly over a WireGuard VPN, the machine running the service must allow the inbound TCP port and the VPN hub must allow forwarded peer-to-peer traffic.

Example service startup on the admin Mac (`10.0.0.10`):

```bash
TEXT_EXTRACTION_HOST=0.0.0.0 ./tools/text_extraction/run.sh
```

If your VPN hub is the VPS from the Raspberry Pi deployment guide and it uses `sudo ufw default deny routed`, add an explicit routed allow rule there for the Infumap host (`10.0.0.2`) to reach the text extraction service on the admin Mac (`10.0.0.10`):

```bash
sudo ufw route allow in on wg0 out on wg0 from 10.0.0.2/32 to 10.0.0.10/32 port 8787 proto tcp
sudo ufw reload
```

Then point Infumap at:

```text
http://10.0.0.10:8787/convert
```

If `10.0.0.1` can reach the service but `10.0.0.2` cannot, that usually means the VPN hub is still dropping forwarded `wg0` peer-to-peer traffic.

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
