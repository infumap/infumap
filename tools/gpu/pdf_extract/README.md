# PDF Extract

This is a small HTTP service for extracting uploaded PDFs to Markdown. It tries
[Docling](https://github.com/docling-project/docling) with OCR disabled, checks
native-text coverage, and falls back to [Marker](https://github.com/datalab-to/marker)
for the whole document when native extraction is inadequate.

Intended for burst or long running use.

## What It Does

- accepts a multipart `file` upload at `POST /pdf-extract`; other fields are ignored
- returns Markdown and extraction metadata as JSON, including the selected
  backend and the reason for any Marker fallback
- loads Marker predictor clients on the first fallback; the Surya VLM
  `llama-server` is spawned on first layout or OCR use
- uses a fixed extraction policy chosen by the tool

## Start The Service

Requirements:

- `python3` 3.10 through 3.13
- `python3-venv`

Set `PYTHON_BIN=/path/to/python3.13` if your default `python3` is too old or too new.
On macOS, `brew install python@3.13` is enough for the launcher to find it.

From the repo root:

```bash
./tools/gpu/pdf_extract/run.sh
```

On first run this creates `tools/gpu/pdf_extract/.venv` and installs:

- `marker-pdf[full]`
- `fastapi`
- `uvicorn`
- `python-multipart`
- `pypdfium2`

It also creates `tools/gpu/pdf_extract/.venv-docling` using
`requirements-docling.txt`. The environments must be separate: Marker 2.0.0
requires Transformers `>=5.12.1,<6`, while Docling IBM Models 3.15.0 requires
`<5.9` on macOS. The launcher installs each environment's requirements again
when its requirements file changes. Both virtualenvs are retained on exit.

By default the service listens on `127.0.0.1:8790`.

`run.sh` supervises a `uvicorn` process. If the text extraction service crashes
(including a segfault), the script logs the exit and restarts it automatically after
a short delay. Pressing `Ctrl-C` still stops the supervisor cleanly.

Optional environment variables:

- `TEXT_EXTRACTION_HOST`
- `TEXT_EXTRACTION_PORT`
- `TEXT_EXTRACTION_VENV_DIR`
- `TEXT_EXTRACTION_DOCLING_VENV_DIR` (default `.venv-docling` next to `app.py`)
- `TEXT_EXTRACTION_RESTART_DELAY_SECS`
- `TEXT_EXTRACTION_MAX_UPLOAD_BYTES`
- `TEXT_EXTRACTION_CONVERSION_TIMEOUT_SECS`
- `TEXT_EXTRACTION_WORKER_SLOT_WAIT_TIMEOUT_SECS`
- `TEXT_EXTRACTION_MODE` (default `balanced`; set `fast` for the lighter layout path)
- `SURYA_GUIDED_LAYOUT` (default `0`). Current Homebrew `llama.cpp` cannot parse Surya's layout JSON schema (`\d` in bbox patterns), so guided decoding fails every page. Keep the default unless your `llama-server` supports that grammar, then set `1`.
- `PYTHON_BIN`
- `GOOGLE_API_KEY`

Examples:

```bash
TEXT_EXTRACTION_PORT=9000 ./tools/gpu/pdf_extract/run.sh
```

```bash
TEXT_EXTRACTION_MODE=fast ./tools/gpu/pdf_extract/run.sh
```

```bash
SURYA_GUIDED_LAYOUT=1 ./tools/gpu/pdf_extract/run.sh
```

The Marker fallback uses a fixed extraction policy:

- `force_ocr=false`
- `paginate_output=true`
- `use_llm=true` only when `GOOGLE_API_KEY` is present in the environment at startup
- `mode=balanced` unless `TEXT_EXTRACTION_MODE=fast`; this is service
  configuration and cannot be overridden by a request.
- `SURYA_GUIDED_LAYOUT=0` unless overridden

## Access Over SSH

If the service is running on `my-host`:

```bash
ssh -L 8790:127.0.0.1:8790 my-host
```

(locally)

Then use `http://127.0.0.1:8790` locally as if the service were running on your laptop.

## Access Over VPN

If you bind the service to `0.0.0.0` and want to reach it directly over a WireGuard VPN, the machine running the service must allow the inbound TCP port and the VPN hub must allow forwarded peer-to-peer traffic.

Example service startup on the admin Mac (`10.0.0.10`):

```bash
TEXT_EXTRACTION_HOST=0.0.0.0 ./tools/gpu/pdf_extract/run.sh
```

If your VPN hub is the VPS from the Raspberry Pi deployment guide and it uses `sudo ufw default deny routed`, add an explicit routed allow rule there for the Infumap host (`10.0.0.2`) to reach the text extraction service on the admin Mac (`10.0.0.10`):

```bash
sudo ufw route allow in on wg0 out on wg0 from 10.0.0.2/32 to 10.0.0.10/32 port 8790 proto tcp
sudo ufw reload
```

Then point Infumap at:

```text
http://10.0.0.10:8790/pdf-extract
```

If `10.0.0.1` can reach the service but `10.0.0.2` cannot, that usually means the VPN hub is still dropping forwarded `wg0` peer-to-peer traffic.

## Extract A File

Example upload request:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  http://127.0.0.1:8790/pdf-extract
```

Print only the markdown:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf" \
  http://127.0.0.1:8790/pdf-extract \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["markdown"])'
```

## Endpoints

- `GET /`
- `GET /healthz`
- `GET /gpu-tools`
- `POST /pdf-extract`
- `POST /convert` legacy alias

Password-protected PDFs return HTTP 422 with a structured terminal response:

```json
{
  "success": false,
  "error_code": "pdf_password_required",
  "error": "The PDF is password protected and cannot be processed without a password.",
  "metadata": {
    "error_code": "pdf_password_required"
  }
}
```

## Notes

- The `/pdf-extract` endpoint parses the multipart body directly from the
  request stream instead of using FastAPI `UploadFile`, so the service code
  can enforce its own upload size cap while reading the request.
- The service uses `pypdfium2` before conversion to identify password-protected
  and recognized malformed PDFs and return a stable terminal error.
- Both backends own their temporary files and delete them after conversion.
- Because uploads stay in memory, the wrapper enforces an in-memory upload cap.
  The default is `134217728` bytes (128 MiB), configurable via
  `TEXT_EXTRACTION_MAX_UPLOAD_BYTES`.
- Docling and any Marker fallback share one
  `TEXT_EXTRACTION_CONVERSION_TIMEOUT_SECS` deadline (default 3600 seconds).
  A timeout returns a terminal 422 failure, stops any Docling child process,
  and restarts the supervised service to clear stuck native state. Marker
  does not get a new timeout budget after Docling.
Interactive API docs are available at `http://127.0.0.1:8790/docs`.

## Conversion Backends

`app.py` owns HTTP uploads, request serialization, error responses, and the
conversion watchdog. `extractor.py` owns the backend instances and the routing
entry point. There is no backend selector in the public API.

`marker_backend.py` owns Marker's configuration, model clients, temporary PDF,
and Markdown conversion. Its extraction policy is retained; its models are
loaded only when fallback is required and remain resident afterwards.

`docling_backend.py` invokes `docling_worker.py` with the isolated Docling Python.
An invocation starts one worker, bounds its lifetime with an explicit timeout,
and reads its structured JSON result from a temporary directory. A timed-out
worker is killed and reaped. Each PDF starts a fresh Docling process; this
isolates memory and failures but adds model startup overhead.

The worker uses Groundwork's `tools/docling_extract/app.py` settings:

- native PDF text with OCR disabled;
- TableFormer V1, accurate mode, with cell matching;
- heading hierarchy enabled and parsed pages retained;
- code/formula enrichment, picture classification/descriptions, and chart
  extraction disabled;
- page, picture, and table image exports disabled.

It transports Docling's document, parsed pages, predictions, confidence,
conversion status/errors, package versions, input page count, coverage
assessment, and accepted Markdown. Transient
assembly data, duplicate character cells, and bitmap image payloads are omitted.
This is internal worker data, not an HTTP response or a persistent sidecar.
Partial/failed conversion statuses and coverage failures cause whole-document
Marker fallback; the presence of a document alone does not mean extraction succeeded.
Groundwork's custom interpretation and rendering are not included.

### Native Coverage Policy

`docling_quality.py` accepts native output only when all source pages are
accounted for, conversion succeeds without reported errors, and every page
passes the following conservative checks:

- Parsed native text and layout must be available for nonblank pages.
- Pages without native alphanumeric text must render as blank at thumbnail
  resolution. Visible scans, drawings, and text outlined as paths fall back.
- Recognized headers and footers are excluded from body-text counts. Pages
  with images and no native body text fall back. Image-dominated pages
  (at least 65% estimated raster coverage) need at least 200 native body
  characters, preventing a selectable footer from qualifying a scanned page.
- Detected text/table regions covering at least 1% of the page need overlapping
  native text. This uses retained layout predictions; the layout stage may
  remove some empty regions, so this check alone cannot establish completeness.
- Markdown must retain at least 80% of the body's normalized alphanumeric
  character counts. Replacement characters, private-use glyphs, and unexpected
  control characters also cause fallback when at least three such characters
  make up more than 2% of the visible text.
- Items with provenance spanning multiple pages fall back until the exporter
  can preserve them without duplication.

Accepted pages use Docling's built-in Markdown export with empty image
placeholders suppressed, native text inside pictures included, and Infumap's
zero-based numbered page markers. Blank pages keep their physical positions;
an entirely blank PDF returns empty Markdown. This basic export is needed to
serve the native route; more involved export handling remains separate work.

These are routing heuristics, not guarantees of correct reading order, tables,
or complete extraction of text embedded in images. They may send sparse covers
or illustrated pages to Marker, and smaller embedded scans can escape detection.
Thresholds have not yet been calibrated against representative PDFs.

Logs and response metadata report `backend`, `fallback_reason` when relevant,
and Docling diagnostics/coverage under `docling`. Missing dependencies/models,
recognized resource errors, worker crashes, and unexpected worker exceptions are service
errors (HTTP 503), rather than reasons to silently try Marker. Recognized
password/corruption failures remain terminal document errors. Infumap's later
first-page image-caption fallback is unchanged.

### Groundwork Dependency Baseline

The following installed versions were recorded from Groundwork's local
`tools/docling_extract/.venv` on 2026-09-28. Its requirements file pins Docling
itself but leaves these extraction dependencies floating. Infumap pins them in
`requirements-docling.txt`:

| Package | Version |
| --- | --- |
| docling / docling-slim | 2.115.0 |
| docling-core | 2.95.0 |
| docling-parse | 7.17.0 |
| docling-ibm-models | 3.15.0 |
| pypdfium2 | 5.13.0 |

Groundwork's environment also used Python 3.14.4, Torch 2.14.0, Torchvision
0.29.0, and Transformers 5.16.1 on Linux. These are recorded for comparison,
not imposed on all platforms: the GPU launchers retain Python 3.10–3.13 support,
and Docling's macOS Transformers constraint differs. This is an extraction
package baseline, not a complete transitive dependency or model-weight lock.
Marker retains its separate PDFium 5.10.1 pin required by pdftext.

Dependency resolution was checked from Linux for Linux x86-64 and macOS ARM64
targets using Python 3.13 package constraints. No macOS installation or runtime
was exercised. Resolution does not establish conversion quality or runtime
compatibility; those require extraction runs on the target machine.
