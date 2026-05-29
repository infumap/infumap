# Image Extract

This service runs local image extraction through a `llama-server` instance.

The default launcher path does three things for you:

- creates a Python virtualenv for the service
- downloads the GGUF + `mmproj` files if they are missing
- starts an installed `llama-server` binary

The service accepts multipart image uploads and forwards them to `llama-server`
via its OpenAI-compatible chat completions endpoint. It also has a PDF
first-page caption fallback endpoint that renders the first page before calling
the same model. Full image extraction computes a local image embedding in
parallel using `facebook/dinov2-with-registers-base` by default when the
optional `torch` / `torchvision` / `transformers` dependencies are available.

## Default Layout

By default:

- the HTTP service listens on `127.0.0.1:8788`
- local `llama-server` listens on `127.0.0.1:18080`
- model files live in the standard Hugging Face cache by default
- the launcher uses:
  - repo: `unsloth/Qwen3.5-9B-GGUF`
  - model file: `Qwen3.5-9B-Q4_K_M.gguf`
  - mmproj file: `mmproj-BF16.gguf`

## Requirements

Minimum requirements:

- `python3` 3.10 through 3.13
- `python3-venv`

Set `PYTHON_BIN=/path/to/python3.13` if your default `python3` is too old or too new.
On macOS, `brew install python@3.13` is enough for the launcher to find it.

Install `llama-server` separately, or set `IMAGE_TAGGING_LLAMA_BIN` to an
executable `llama-server` path.

## Start The Service

From the repo root:

```bash
./tools/gpu/image_extract/run.sh
```

That command will:

1. create or reuse `tools/gpu/image_extract/.venv`
2. install the Python wrapper and embedding dependencies
3. download the configured model files if they are missing
4. ensure `llama-server` exists
5. start `llama-server`
6. start the `/image-extract` service

## Important Environment Variables

API wrapper:

- `IMAGE_TAGGING_HOST`
- `IMAGE_TAGGING_PORT`
- `IMAGE_TAGGING_VENV_DIR`
- `IMAGE_TAGGING_MAX_UPLOAD_BYTES`
- `IMAGE_TAGGING_TARGET_MAX_PIXELS`
- `IMAGE_TAGGING_TARGET_MAX_LONG_EDGE`
- `IMAGE_TAGGING_OUTPUT_JPEG_QUALITY`
- `IMAGE_TAGGING_PDF_RENDER_SCALE`
- `IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING`
- `IMAGE_TAGGING_EMBEDDING_MODEL_ID`
- `IMAGE_TAGGING_EMBEDDING_DEVICE`

llama-server management:

- `IMAGE_TAGGING_MANAGE_LLAMA_SERVER`
- `IMAGE_TAGGING_LLAMA_SERVER_URL`
- `IMAGE_TAGGING_LLAMA_HOST`
- `IMAGE_TAGGING_LLAMA_PORT`
- `IMAGE_TAGGING_LLAMA_BIN`
- `IMAGE_TAGGING_LLAMA_EXTRA_ARGS`

Model selection:

- `IMAGE_TAGGING_MODEL` exact selector in `<huggingface-repo>:<gguf-file>`
  form. You can also pass this selector as the first `run.sh` argument. If
  unset, the launcher uses
  `unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf`.
- `IMAGE_TAGGING_MODEL_REPO`
- `IMAGE_TAGGING_MODEL_FILE`
- `IMAGE_TAGGING_MMPROJ_FILE`
- `IMAGE_TAGGING_MODEL_ID`
- `IMAGE_TAGGING_LLAMA_MODEL_NAME`

Default llama-server runtime flags:

- `IMAGE_TAGGING_LLAMA_CTX` default `8192`
- `IMAGE_TAGGING_LLAMA_BATCH_SIZE` default `2048`
- `IMAGE_TAGGING_LLAMA_UBATCH_SIZE` default `512`
- `IMAGE_TAGGING_LLAMA_NGL` default `all` when `nvidia-smi` is present, else `0`
- `IMAGE_TAGGING_LLAMA_FLASH_ATTN` default `auto` when `nvidia-smi` is present
- `IMAGE_TAGGING_LLAMA_IMAGE_MIN_TOKENS` optional pass-through to `llama-server`
- `IMAGE_TAGGING_LLAMA_IMAGE_MAX_TOKENS` optional pass-through to `llama-server`
- `IMAGE_TAGGING_LLAMA_REASONING_FORMAT` default `none`

## Common Examples

Run on a different external API port:

```bash
IMAGE_TAGGING_PORT=9001 ./tools/gpu/image_extract/run.sh
```

Point the service at an already-running external `llama-server` and skip local
model/binary management:

```bash
IMAGE_TAGGING_MANAGE_LLAMA_SERVER=0 \
IMAGE_TAGGING_LLAMA_SERVER_URL=http://127.0.0.1:18080 \
./tools/gpu/image_extract/run.sh
```

Use a different GGUF within the default repo:

```bash
IMAGE_TAGGING_MODEL_FILE=Qwen3.5-9B-Q6_K.gguf ./tools/gpu/image_extract/run.sh
```

Run a different Hugging Face repo/file:

```bash
IMAGE_TAGGING_LLAMA_EXTRA_ARGS='--chat-template-kwargs {"enable_thinking":false}' \
./tools/gpu/image_extract/run.sh \
  unsloth/gemma-4-26B-A4B-it-GGUF:gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf
```

Pass extra flags straight through to `llama-server`:

```bash
IMAGE_TAGGING_LLAMA_EXTRA_ARGS="--jinja --reasoning-format none" ./tools/gpu/image_extract/run.sh
```

## Endpoints

- `GET /`
- `GET /healthz`
- `GET /gpu-tools`
- `POST /image-extract`
- `POST /image-extract-caption-only`
- `POST /pdf-extract-caption-only`

Interactive docs remain available at `http://127.0.0.1:8788/docs`.

## Example Request

```bash
curl -sS \
  -F "file=@/path/to/photo.jpg" \
  http://127.0.0.1:8788/image-extract
```

Caption-only extraction:

```bash
curl -sS \
  -F "file=@/path/to/photo.jpg" \
  http://127.0.0.1:8788/image-extract-caption-only
```

PDF first-page caption-only extraction:

```bash
curl -sS \
  -F "file=@/path/to/document.pdf;type=application/pdf" \
  http://127.0.0.1:8788/pdf-extract-caption-only
```

Password-protected PDFs sent to `POST /pdf-extract-caption-only` return HTTP
422 with a structured terminal response:

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

- The HTTP service uses the multimodal chat model running behind
  `llama-server`, plus a local DINOv2 image-embedding model in the FastAPI
  process.
- When `run.sh` manages `llama-server`, it now defaults to
  `--reasoning-format none` so the model returns final JSON instead of
  spending the token budget on reasoning traces.
- The wrapper first tries the standard OpenAI `image_url` chat format. If the
  running `llama-server` build rejects that format, it automatically retries
  using the older `image_data` payload style.
- GPU-facing inference is intentionally serialized: uploads and preprocessing
  may overlap, but only one `llama-server` request is allowed to execute at a
  time.
- The `/image-extract` endpoint parses the multipart body directly from the
  request stream instead of using FastAPI `UploadFile`, so the service code
  does not spool uploads to temp files on disk.
- The `/image-extract` JSON response also includes
  `face_recognition_candidate_confidence` and
  `visible_face_count_estimate` so downstream services can decide whether an
  image is worth sending to a dedicated face-matching pipeline.
- The `/image-extract` JSON response also includes `image_embedding` as the last
  field. The vector is L2-normalized and is produced in parallel with the
  tagging request for the same prepared image.
- The `/image-extract-caption-only` endpoint uses a narrower prompt that asks for
  only the `detailed_caption` model field and skips local image embedding.
- The `/image-extract` endpoint first tries the full structured extraction. If
  the model returns malformed or truncated non-JSON output, it retries once with
  the caption-only prompt and returns a normal image extraction response with
  the caption, image embedding, and conservative empty defaults for the richer
  fields. Callers can also force this fallback-only path by sending
  `X-Infumap-Image-Extract-Mode: caption_fallback`.
- The `/pdf-extract-caption-only` endpoint accepts only `application/pdf`,
  renders the first page to an image in memory, then uses the same caption-only
  prompt. It does not perform PDF text extraction or OCR, and password-protected
  PDFs are rejected before any model request is made.
- Because uploads stay in memory, the wrapper enforces an in-memory upload cap.
  The default is `67108864` bytes (64 MiB), configurable via
  `IMAGE_TAGGING_MAX_UPLOAD_BYTES`.
- Before calling the model, the wrapper now resizes oversized images
  conservatively and re-encodes them as JPEG for better efficiency. By default
  it caps inputs to `2048` pixels on the long edge and about `3.1` megapixels
  total, with JPEG quality `90`.
- That default is aimed at photo understanding and document-like detection, not
  tiny-text OCR. The knobs are `IMAGE_TAGGING_TARGET_MAX_LONG_EDGE`,
  `IMAGE_TAGGING_TARGET_MAX_PIXELS`, and `IMAGE_TAGGING_OUTPUT_JPEG_QUALITY`.
