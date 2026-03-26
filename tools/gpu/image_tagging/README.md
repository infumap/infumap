# Image Tagging

This service runs local image understanding through a `llama-server` instance.

The default launcher path does three things for you:

- creates a Python virtualenv for the service
- downloads the GGUF + `mmproj` files if they are missing
- uses an existing `llama-server` binary, or clones/builds `ggml-org/llama.cpp`
  locally if one is not already available

The service accepts multipart image uploads and forwards them to `llama-server`
via its OpenAI-compatible chat completions endpoint. It also computes a local
image embedding in parallel using `facebook/dinov2-with-registers-base` by
default.

## Default Layout

By default:

- the HTTP service listens on `127.0.0.1:8788`
- local `llama-server` listens on `127.0.0.1:18080`
- model files live under `tools/gpu/image_tagging/models`
- the launcher uses:
  - repo: `unsloth/Qwen3.5-9B-GGUF`
  - model file: `Qwen3.5-9B-Q4_K_M.gguf`
  - mmproj file: `mmproj-BF16.gguf`

## Requirements

Minimum requirements:

- `python3`
- `python3-venv`

If `llama-server` is already installed and on `PATH`, that is enough.

If the launcher needs to build `llama.cpp` locally, you also need:

- `git`
- `cmake`
- a working C/C++ toolchain
- CUDA build dependencies if you want GPU acceleration from a local build

## Start The Service

From the repo root:

```bash
./tools/gpu/image_tagging/run.sh
```

That command will:

1. create or reuse `tools/gpu/image_tagging/.venv`
2. install the Python wrapper and embedding dependencies
3. download the configured model files if they are missing
4. ensure `llama-server` exists
5. start `llama-server`
6. start the `/tag` service

## Important Environment Variables

API wrapper:

- `IMAGE_TAGGING_HOST`
- `IMAGE_TAGGING_PORT`
- `IMAGE_TAGGING_VENV_DIR`
- `IMAGE_TAGGING_MAX_UPLOAD_BYTES`
- `IMAGE_TAGGING_TARGET_MAX_PIXELS`
- `IMAGE_TAGGING_TARGET_MAX_LONG_EDGE`
- `IMAGE_TAGGING_OUTPUT_JPEG_QUALITY`
- `IMAGE_TAGGING_ENABLE_IMAGE_EMBEDDING`
- `IMAGE_TAGGING_EMBEDDING_MODEL_ID`
- `IMAGE_TAGGING_EMBEDDING_DEVICE`

llama-server management:

- `IMAGE_TAGGING_MANAGE_LLAMA_SERVER`
- `IMAGE_TAGGING_LLAMA_SERVER_URL`
- `IMAGE_TAGGING_LLAMA_HOST`
- `IMAGE_TAGGING_LLAMA_PORT`
- `IMAGE_TAGGING_LLAMA_BIN`
- `IMAGE_TAGGING_LLAMA_CPP_DIR`
- `IMAGE_TAGGING_LLAMA_CPP_REPO_URL`
- `IMAGE_TAGGING_LLAMA_UPDATE_CHECKOUT`
- `IMAGE_TAGGING_LLAMA_CMAKE_ARGS`
- `IMAGE_TAGGING_LLAMA_EXTRA_ARGS`

Model selection:

- `IMAGE_TAGGING_MODELS_DIR`
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
IMAGE_TAGGING_PORT=9001 ./tools/gpu/image_tagging/run.sh
```

Point the service at an already-running external `llama-server` and skip local
model/binary management:

```bash
IMAGE_TAGGING_MANAGE_LLAMA_SERVER=0 \
IMAGE_TAGGING_LLAMA_SERVER_URL=http://127.0.0.1:18080 \
./tools/gpu/image_tagging/run.sh
```

Use a different GGUF within the same repo:

```bash
IMAGE_TAGGING_MODEL_FILE=Qwen3.5-9B-Q6_K.gguf ./tools/gpu/image_tagging/run.sh
```

Pass extra flags straight through to `llama-server`:

```bash
IMAGE_TAGGING_LLAMA_EXTRA_ARGS="--jinja --reasoning-format none" ./tools/gpu/image_tagging/run.sh
```

## Endpoints

- `GET /`
- `GET /healthz`
- `POST /tag`

Interactive docs remain available at `http://127.0.0.1:8788/docs`.

## Example Request

```bash
curl -sS \
  -F "file=@/path/to/photo.jpg" \
  http://127.0.0.1:8788/tag
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
- The `/tag` endpoint now parses the multipart body directly from the request
  stream instead of using FastAPI `UploadFile`, so the service code does not
  spool uploads to temp files on disk.
- The `/tag` JSON response now also includes
  `face_recognition_candidate_confidence` and
  `visible_face_count_estimate` so downstream services can decide whether an
  image is worth sending to a dedicated face-matching pipeline.
- The `/tag` JSON response now also includes `image_embedding` as the last
  field. The vector is L2-normalized and is produced in parallel with the
  tagging request for the same prepared image.
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
