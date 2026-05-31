# Text Embed

This service exposes Infumap's public text embedding API and uses a private
`llama-server` process for the actual embedding work.

The model is intentionally fixed to the Q8 GGUF build of Qwen3 Embedding 0.6B:

```bash
Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0
```

There is no environment variable or launcher option to change this model.
Requests may omit `model`; if they include it, it must match the fixed model
above.

## Start The Service

Requirements:

- `python3` 3.10 through 3.13
- `python3-venv`
- `llama-server` on `PATH`, or `TEXT_EMBEDDING_LLAMA_BIN=/path/to/llama-server`

From the repo root:

```bash
./tools/gpu/text_embed/run.sh
```

By default:

- the public FastAPI wrapper listens on `127.0.0.1:8789`
- the managed private `llama-server` listens on `127.0.0.1:18089`
- both the direct service and the shared GPU gateway expose `POST /text-embed`

Direct service URL:

```bash
http://127.0.0.1:8789/text-embed
```

Shared gateway URL:

```bash
http://127.0.0.1:8787/text-embed
```

## Important Environment Variables

Public wrapper:

- `TEXT_EMBEDDING_HOST`
- `TEXT_EMBEDDING_PORT`
- `TEXT_EMBEDDING_VENV_DIR`

Managed llama-server:

- `TEXT_EMBEDDING_LLAMA_HOST`
- `TEXT_EMBEDDING_LLAMA_PORT`
- `TEXT_EMBEDDING_LLAMA_BIN`
- `TEXT_EMBEDDING_LLAMA_CTX`
- `TEXT_EMBEDDING_LLAMA_BATCH_SIZE`
- `TEXT_EMBEDDING_LLAMA_UBATCH_SIZE`
- `TEXT_EMBEDDING_LLAMA_PARALLEL`
- `TEXT_EMBEDDING_LLAMA_POOLING`
- `TEXT_EMBEDDING_LLAMA_NGL`
- `TEXT_EMBEDDING_STARTUP_TIMEOUT_SECS`

These variables tune the wrapper and managed `llama-server` process. None of
them changes the fixed embedding model.

Defaults:

- `TEXT_EMBEDDING_LLAMA_CTX=32768`
- `TEXT_EMBEDDING_LLAMA_POOLING=last`
- `TEXT_EMBEDDING_LLAMA_NGL=all` on NVIDIA or macOS hosts, otherwise `0`

## Example Requests

Direct wrapper request:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "input": [
      "Document: Example.pdf\n\nThis is the first fragment.",
      "Document: Example.pdf\n\nThis is the second fragment."
    ]
  }' \
  http://127.0.0.1:8789/text-embed
```

The same public API through the gateway:

```bash
curl -sS \
  -H 'content-type: application/json' \
  -d '{
    "input": ["Instruct: Given a web search query, retrieve relevant passages that answer the query\n Query:mandarin oriental kuala lumpur booking details"]
  }' \
  http://127.0.0.1:8787/text-embed
```

## Endpoints

Direct wrapper:

- `GET /`
- `GET /healthz`
- `GET /gpu-tools`
- `GET /health`
- `GET /v1/models`
- `POST /text-embed`
- `POST /embed` legacy alias
- `POST /v1/embeddings`

Gateway:

- `GET /healthz`
- `GET /gpu-tools`
- `POST /text-embed`

## Notes

- `/text-embed` uses an OpenAI-compatible embedding payload with `input` and
  optional `encoding_format`. The wrapper always forwards the fixed Qwen model
  to `llama-server`.
- `POST /v1/embeddings` remains available on the direct wrapper for
  compatibility, but Infumap's public endpoint is `/text-embed`.
- Infumap's Rust embedding API distinguishes retrieval documents from retrieval
  queries. Fragment documents are embedded as-is. Search queries are embedded
  with Qwen's retrieval instruction prefix:
  `Instruct: Given a web search query, retrieve relevant passages that answer the query`.
- The OpenAI-compatible endpoint requires pooling other than `none`; the
  launcher defaults to `last`.
- On macOS, a Homebrew or source-built `llama-server` normally uses Metal when
  the binary was built with Metal support. The launcher requests GPU layers by
  default on macOS.
