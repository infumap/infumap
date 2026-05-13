# Copyright (C) The Infumap Authors
# This file is part of Infumap.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

from __future__ import annotations

import logging
import os
import platform
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0"
LOGGER = logging.getLogger("infumap.text_embedding")


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Invalid float for %s=%r; using %s", name, raw, default)
        return default


def llama_server_url() -> str:
    host = os.environ.get("TEXT_EMBEDDING_LLAMA_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = os.environ.get("TEXT_EMBEDDING_LLAMA_PORT", "18089").strip() or "18089"
    return f"http://{host}:{port}"


def rooted_path(request: Request, path: str) -> str:
    root_path = request.scope.get("root_path", "")
    if not root_path:
        return path
    return f"{str(root_path).rstrip('/')}/{path.lstrip('/')}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    timeout = httpx.Timeout(
        connect=max(5.0, env_float("TEXT_EMBEDDING_LLAMA_CONNECT_TIMEOUT_SECS", 10.0)),
        read=max(30.0, env_float("TEXT_EMBEDDING_LLAMA_READ_TIMEOUT_SECS", 30.0 * 60.0)),
        write=max(30.0, env_float("TEXT_EMBEDDING_LLAMA_WRITE_TIMEOUT_SECS", 60.0)),
        pool=max(5.0, env_float("TEXT_EMBEDDING_LLAMA_POOL_TIMEOUT_SECS", 60.0)),
    )
    client = httpx.AsyncClient(base_url=llama_server_url(), timeout=timeout)
    app.state.llama_client = client
    LOGGER.info(
        "Text embedding startup: python=%s platform=%s model_id=%s llama_server_url=%s",
        platform.python_version(),
        platform.platform(),
        MODEL_ID,
        llama_server_url(),
    )
    try:
        yield
    finally:
        app.state.llama_client = None
        await client.aclose()


app = FastAPI(
    title="Infumap Text Embedding",
    version="0.1.0",
    lifespan=lifespan,
)


def llama_client(request: Request) -> httpx.AsyncClient:
    client = getattr(request.app.state, "llama_client", None)
    if client is None:
        raise HTTPException(status_code=503, detail="Text embedding service is not ready.")
    return client


def normalize_embedding_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Embedding request body must be a JSON object.")

    if "input" not in payload:
        raise HTTPException(status_code=422, detail="Embedding request body must include 'input'.")

    raw_model = payload.get("model")
    requested_model = raw_model.strip() if isinstance(raw_model, str) else ""
    if raw_model is not None and not isinstance(raw_model, str):
        requested_model = str(raw_model).strip()
    if requested_model and requested_model != MODEL_ID:
        raise HTTPException(status_code=400, detail=f"This service only supports model {MODEL_ID!r}.")

    normalized = dict(payload)
    normalized["model"] = MODEL_ID
    normalized.setdefault("encoding_format", "float")
    return normalized


async def probe_llama_server(client: httpx.AsyncClient) -> tuple[bool, Any]:
    first_error: str | None = None
    for path in ("/health", "/v1/models", "/"):
        try:
            response = await client.get(path)
        except httpx.HTTPError as exc:
            if first_error is None:
                first_error = str(exc)
            continue

        if response.status_code < 400:
            try:
                return True, response.json()
            except ValueError:
                return True, response.text

        if first_error is None:
            first_error = response.text

    return False, first_error or "llama-server did not return a successful health response"


@app.get("/")
async def root(request: Request) -> dict[str, Any]:
    return {
        "service": "infumap-text-embedding",
        "model_id": MODEL_ID,
        "docs": rooted_path(request, "/docs"),
        "health": rooted_path(request, "/healthz"),
        "text_embed": rooted_path(request, "/text-embed"),
        "embed": rooted_path(request, "/embed"),
    }


@app.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    ok, detail = await probe_llama_server(llama_client(request))
    return JSONResponse(
        status_code=200 if ok else 503,
        content={
            "ok": ok,
            "model_id": MODEL_ID,
            "llama_server_url": llama_server_url(),
            "detail": detail,
        },
    )


@app.get("/health")
async def health(request: Request) -> JSONResponse:
    return await healthz(request)


@app.get("/v1/models")
async def models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "owned_by": "infumap",
            }
        ],
    }


async def embed_with_llama(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse JSON request body: {exc}") from exc

    normalized = normalize_embedding_payload(payload)
    client = llama_client(request)
    try:
        response = await client.post("/v1/embeddings", json=normalized)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"llama-server is unavailable: {exc}") from exc

    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text)

    try:
        content = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Could not parse llama-server JSON response: {exc}") from exc

    if isinstance(content, dict):
        content["model"] = MODEL_ID

    return JSONResponse(status_code=response.status_code, content=content)


@app.post("/text-embed")
@app.post("/embed")
async def embed(request: Request) -> JSONResponse:
    return await embed_with_llama(request)


@app.post("/v1/embeddings")
async def openai_embeddings(request: Request) -> JSONResponse:
    return await embed_with_llama(request)
