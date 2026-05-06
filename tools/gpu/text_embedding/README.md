# Text Embedding

This service runs a local `llama-server` in embedding mode.

By default it serves the Q8 GGUF build of Qwen3 Embedding 0.6B:

```bash
Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0
```

`llama-server` needs a GGUF model. If you want to use a converted build from a
different repo, set `TEXT_EMBEDDING_HF_MODEL`. If you already have a local GGUF,
set `TEXT_EMBEDDING_MODEL_PATH`.

## Start The Service

Requirements:

- `llama-server` on `PATH`, or `TEXT_EMBEDDING_LLAMA_BIN=/path/to/llama-server`

From the repo root:

```bash
./tools/gpu/text_embedding/run.sh
```

The direct upstream service listens on `127.0.0.1:8789` by default and exposes
llama.cpp's OpenAI-compatible embedding endpoint:

```bash
http://127.0.0.1:8789/v1/embeddings
```

The shared GPU gateway still exposes Infumap's public embedding URL:

```bash
http://127.0.0.1:8787/embed
```

The gateway maps that public `/embed` path to the upstream
`/v1/embeddings` endpoint.

## Important Environment Variables

- `TEXT_EMBEDDING_HOST`
- `TEXT_EMBEDDING_PORT`
- `TEXT_EMBEDDING_LLAMA_BIN`
- `TEXT_EMBEDDING_HF_MODEL`
- `TEXT_EMBEDDING_MODEL_PATH`
- `TEXT_EMBEDDING_LLAMA_CTX`
- `TEXT_EMBEDDING_LLAMA_BATCH_SIZE`
- `TEXT_EMBEDDING_LLAMA_UBATCH_SIZE`
- `TEXT_EMBEDDING_LLAMA_PARALLEL`
- `TEXT_EMBEDDING_LLAMA_POOLING`
- `TEXT_EMBEDDING_LLAMA_NGL`
- `TEXT_EMBEDDING_LLAMA_EXTRA_ARGS`
- `TEXT_EMBEDDING_RESTART_DELAY_SECS`
- `TEXT_EMBEDDING_STARTUP_TIMEOUT_SECS`

Defaults:

- `TEXT_EMBEDDING_HF_MODEL=Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0`
- `TEXT_EMBEDDING_LLAMA_CTX=32768`
- `TEXT_EMBEDDING_LLAMA_POOLING=last`
- `TEXT_EMBEDDING_LLAMA_NGL=all` on NVIDIA or macOS hosts, otherwise `0`

## Example Requests

Direct llama-server request:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "model": "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0",
    "input": [
      "Document: Example.pdf\n\nThis is the first fragment.",
      "Document: Example.pdf\n\nThis is the second fragment."
    ]
  }' \
  http://127.0.0.1:8789/v1/embeddings
```

The same request through the gateway:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "model": "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0",
    "input": ["Instruct: Given a web search query, retrieve relevant passages that answer the query\n Query:mandarin oriental kuala lumpur booking details"]
  }' \
  http://127.0.0.1:8787/embed
```

## Endpoints

Direct `llama-server`:

- `GET /`
- `GET /health`
- `GET /v1/models`
- `POST /v1/embeddings`

Gateway:

- `GET /healthz`
- `POST /embed`

## Notes

- The old FastAPI `/embed` payload shape is gone. Infumap now sends the
  OpenAI-compatible `model` plus `input` payload.
- Infumap's Rust embedding API distinguishes retrieval documents from retrieval
  queries. Fragment documents are embedded as-is. Search queries are embedded
  with Qwen's retrieval instruction prefix:
  `Instruct: Given a web search query, retrieve relevant passages that answer the query`.
- The OpenAI-compatible endpoint requires pooling other than `none`; the
  launcher defaults to `last`.
- On macOS, a Homebrew or source-built `llama-server` normally uses Metal when
  the binary was built with Metal support. The launcher requests GPU layers by
  default on macOS.
