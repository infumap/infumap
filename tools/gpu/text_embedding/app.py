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

import asyncio
import logging
import os
import platform
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from fastembed import TextEmbedding
from fastembed.common.model_description import ModelSource, PoolingType

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
EMBED_SEMAPHORE: asyncio.Semaphore | None = None

DEFAULT_MAX_BATCH_ITEMS = 256
DEFAULT_MAX_TEXT_CHARS = 32_768
DEFAULT_MAX_CONCURRENCY = 1
DEFAULT_MODEL_CACHE_DIR = Path(__file__).resolve().parent / "models"

COMPATIBLE_MODEL_NAME = "Xenova/bge-base-en-v1.5"
FASTEMBED_PUBLIC_ALIAS = "BAAI/bge-base-en-v1.5"
COMPATIBLE_MODEL_FILE = "onnx/model.onnx"
COMPATIBLE_MODEL_DIMENSIONS = 768
COMPATIBLE_MODEL_POOLING = "cls"
COMPATIBLE_MODEL_NORMALIZATION = True
COMPATIBLE_WITH_RUST_MODEL = "EmbeddingModel::BGEBaseENV15"
COMPATIBLE_WITH_RUST_CALL = "TextEmbedding::embed"


class EmbedInput(BaseModel):
    id: str | None = None
    text: str


class EmbedRequest(BaseModel):
    inputs: list[EmbedInput] = Field(default_factory=list)


class EmbedResult(BaseModel):
    index: int
    id: str | None = None
    embedding: list[float]


class EmbedResponse(BaseModel):
    success: bool
    model: str
    compatible_with_rust_model: str
    dimensions: int
    normalized: bool
    count: int
    duration_ms: int
    results: list[EmbedResult]


def package_version(package_name: str) -> str:
    try:
        return version(package_name)
    except PackageNotFoundError:
        return "unknown"


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("Invalid integer for %s=%r; using %d", name, raw, default)
        return default


def max_batch_items() -> int:
    return max(1, env_int("TEXT_EMBEDDING_MAX_BATCH_ITEMS", DEFAULT_MAX_BATCH_ITEMS))


def max_text_chars() -> int:
    return max(1, env_int("TEXT_EMBEDDING_MAX_TEXT_CHARS", DEFAULT_MAX_TEXT_CHARS))


def max_concurrency() -> int:
    return max(1, env_int("TEXT_EMBEDDING_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY))


def root_path() -> str:
    configured = os.environ.get("TEXT_EMBEDDING_ROOT_PATH", "").strip()
    if not configured or configured == "/":
        return ""
    return "/" + configured.strip("/")


def model_cache_dir() -> Path:
    configured = os.environ.get("TEXT_EMBEDDING_MODELS_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return DEFAULT_MODEL_CACHE_DIR


def onnx_providers() -> list[str] | None:
    configured = os.environ.get("TEXT_EMBEDDING_PROVIDERS", "").strip()
    if not configured:
        return None
    return [provider.strip() for provider in configured.split(",") if provider.strip()]


def active_onnx_providers(model: TextEmbedding) -> list[str]:
    try:
        session = getattr(getattr(model, "model", None), "model", None)
        get_providers = getattr(session, "get_providers", None)
        if callable(get_providers):
            providers = get_providers()
            if isinstance(providers, list):
                return [str(provider) for provider in providers]
    except Exception:
        pass
    return []


def ensure_compatible_model_registered() -> None:
    existing = getattr(TextEmbedding, "list_supported_models", None)
    if callable(existing):
        for description in existing():
            if isinstance(description, dict):
                if description.get("model") == COMPATIBLE_MODEL_NAME:
                    return
            elif getattr(description, "model", None) == COMPATIBLE_MODEL_NAME:
                return

    TextEmbedding.add_custom_model(
        model=COMPATIBLE_MODEL_NAME,
        pooling=PoolingType.CLS,
        normalization=COMPATIBLE_MODEL_NORMALIZATION,
        sources=ModelSource(hf=COMPATIBLE_MODEL_NAME),
        dim=COMPATIBLE_MODEL_DIMENSIONS,
        model_file=COMPATIBLE_MODEL_FILE,
    )


def build_runtime_summary() -> list[str]:
    providers = onnx_providers()
    provider_summary = ",".join(providers) if providers else "<default>"
    active_provider_summary = ",".join(APP_STATE.get("active_providers", [])) or "<unknown>"
    return [
        f"python={platform.python_version()}",
        f"platform={platform.platform()}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"fastembed={package_version('fastembed')}",
        f"onnxruntime={package_version('onnxruntime')}",
        f"model={COMPATIBLE_MODEL_NAME}",
        f"fastembed_builtin_alias={FASTEMBED_PUBLIC_ALIAS}",
        f"compatible_with_rust_model={COMPATIBLE_WITH_RUST_MODEL}",
        f"compatible_with_rust_call={COMPATIBLE_WITH_RUST_CALL}",
        f"pooling={COMPATIBLE_MODEL_POOLING}",
        f"normalization={COMPATIBLE_MODEL_NORMALIZATION}",
        f"model_cache_dir={model_cache_dir()}",
        f"providers_configured={provider_summary}",
        f"providers_active={active_provider_summary}",
        f"max_batch_items={max_batch_items()}",
        f"max_text_chars={max_text_chars()}",
        f"max_concurrency={max_concurrency()}",
    ]


def build_embedding_model() -> TextEmbedding:
    ensure_compatible_model_registered()
    cache_dir = model_cache_dir()
    cache_dir.mkdir(parents=True, exist_ok=True)

    kwargs: dict[str, Any] = {
        "model_name": COMPATIBLE_MODEL_NAME,
        "cache_dir": str(cache_dir),
    }
    providers = onnx_providers()
    if providers:
        kwargs["providers"] = providers
    try:
        return TextEmbedding(**kwargs)
    except Exception:
        auto_gpu_fallback = os.environ.get("TEXT_EMBEDDING_AUTO_GPU_FALLBACK", "1").strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        if not providers or not auto_gpu_fallback or "CUDAExecutionProvider" not in providers:
            raise
        LOGGER.warning(
            "Could not initialize FastEmbed with providers=%s; falling back to CPUExecutionProvider.",
            providers,
            exc_info=True,
        )
        fallback_kwargs = dict(kwargs)
        fallback_kwargs["providers"] = ["CPUExecutionProvider"]
        return TextEmbedding(**fallback_kwargs)


def embed_texts(texts: list[str]) -> list[list[float]]:
    model: TextEmbedding = APP_STATE["embedding_model"]
    vectors = list(model.embed(texts))
    return [vector.tolist() for vector in vectors]


def validate_inputs(request: EmbedRequest) -> list[str]:
    if not request.inputs:
        raise HTTPException(status_code=400, detail="Request must include at least one input.")
    if len(request.inputs) > max_batch_items():
        raise HTTPException(
            status_code=413,
            detail=f"Request contains {len(request.inputs)} inputs; limit is {max_batch_items()}.",
        )

    texts: list[str] = []
    char_limit = max_text_chars()
    for index, item in enumerate(request.inputs):
        if not item.text.strip():
            raise HTTPException(status_code=400, detail=f"Input {index} text must not be blank.")
        if len(item.text) > char_limit:
            raise HTTPException(
                status_code=413,
                detail=f"Input {index} text length {len(item.text)} exceeds limit {char_limit}.",
            )
        texts.append(item.text)
    return texts


@asynccontextmanager
async def lifespan(_: FastAPI):
    global EMBED_SEMAPHORE

    started_at = time.perf_counter()
    embedding_model = build_embedding_model()
    APP_STATE["embedding_model"] = embedding_model
    APP_STATE["active_providers"] = active_onnx_providers(embedding_model)
    EMBED_SEMAPHORE = asyncio.Semaphore(max_concurrency())
    startup_duration_ms = int((time.perf_counter() - started_at) * 1000)
    LOGGER.info("Text embedding startup: %s", " ".join(build_runtime_summary()))
    LOGGER.info("Text embedding model initialized in %d ms", startup_duration_ms)
    try:
        yield
    finally:
        APP_STATE.clear()
        EMBED_SEMAPHORE = None


app = FastAPI(
    title="Infumap Text Embedding Service",
    version="0.1.0",
    lifespan=lifespan,
    root_path=root_path(),
)


def rooted_path(request: Request, suffix: str) -> str:
    current_root = request.scope.get("root_path", "").rstrip("/")
    if not current_root:
        return suffix
    return f"{current_root}{suffix}"


@app.get("/")
async def root(request: Request) -> dict[str, Any]:
    providers = onnx_providers()
    return {
        "service": "Infumap Text Embedding Service",
        "ready": "embedding_model" in APP_STATE,
        "docs": rooted_path(request, "/docs"),
        "health": rooted_path(request, "/healthz"),
        "embed": rooted_path(request, "/embed"),
        "model": COMPATIBLE_MODEL_NAME,
        "fastembed_builtin_alias": FASTEMBED_PUBLIC_ALIAS,
        "compatible_with_rust_model": COMPATIBLE_WITH_RUST_MODEL,
        "compatible_with_rust_call": COMPATIBLE_WITH_RUST_CALL,
        "dimensions": COMPATIBLE_MODEL_DIMENSIONS,
        "pooling": COMPATIBLE_MODEL_POOLING,
        "normalized": COMPATIBLE_MODEL_NORMALIZATION,
        "providers": providers or [],
        "active_providers": APP_STATE.get("active_providers", []),
        "model_cache_dir": str(model_cache_dir()),
        "max_batch_items": max_batch_items(),
        "max_text_chars": max_text_chars(),
    }


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": "embedding_model" in APP_STATE,
        "model": COMPATIBLE_MODEL_NAME,
        "dimensions": COMPATIBLE_MODEL_DIMENSIONS,
        "active_providers": APP_STATE.get("active_providers", []),
    }


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    if "embedding_model" not in APP_STATE:
        raise HTTPException(status_code=503, detail="Embedding model is not ready yet.")

    texts = validate_inputs(request)
    started_at = time.perf_counter()

    semaphore = EMBED_SEMAPHORE
    if semaphore is None:
        raise HTTPException(status_code=503, detail="Embedding service is not ready yet.")

    async with semaphore:
        vectors = await asyncio.to_thread(embed_texts, texts)

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    results = [
        EmbedResult(index=index, id=item.id, embedding=vector)
        for index, (item, vector) in enumerate(zip(request.inputs, vectors))
    ]
    return EmbedResponse(
        success=True,
        model=COMPATIBLE_MODEL_NAME,
        compatible_with_rust_model=COMPATIBLE_WITH_RUST_MODEL,
        dimensions=COMPATIBLE_MODEL_DIMENSIONS,
        normalized=COMPATIBLE_MODEL_NORMALIZATION,
        count=len(results),
        duration_ms=duration_ms,
        results=results,
    )
