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

import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
}


@dataclass(frozen=True)
class ServiceProxy:
    service_name: str
    public_paths: tuple[str, ...]
    upstream_base_url: str


def upstream_base_url(name: str, default_host: str, default_port: int) -> str:
    configured = os.environ.get(name, "").strip()
    if configured:
        return configured.rstrip("/")
    return f"http://{default_host}:{default_port}"


def service_registry() -> dict[str, ServiceProxy]:
    services = [
        ServiceProxy(
            service_name="image_tagging",
            public_paths=("/tag",),
            upstream_base_url=upstream_base_url("GPU_IMAGE_TAGGING_UPSTREAM_URL", "127.0.0.1", 8788),
        ),
        ServiceProxy(
            service_name="text_embedding",
            public_paths=("/embed",),
            upstream_base_url=upstream_base_url("GPU_TEXT_EMBEDDING_UPSTREAM_URL", "127.0.0.1", 8789),
        ),
        ServiceProxy(
            service_name="text_extraction",
            public_paths=("/convert",),
            upstream_base_url=upstream_base_url("GPU_TEXT_EXTRACTION_UPSTREAM_URL", "127.0.0.1", 8787),
        ),
    ]
    return {service.service_name: service for service in services}


SERVICES = service_registry()


def strip_hop_by_hop_headers(headers: httpx.Headers | dict[str, str]) -> dict[str, str]:
    filtered: dict[str, str] = {}
    for key, value in headers.items():
        if key.lower() in HOP_BY_HOP_HEADERS:
            continue
        filtered[key] = value
    return filtered


def forwarded_headers(request: Request) -> dict[str, str]:
    headers = strip_hop_by_hop_headers(request.headers)
    client_host = request.client.host if request.client else ""
    existing_forwarded_for = headers.get("x-forwarded-for", "").strip()
    if existing_forwarded_for and client_host:
        headers["x-forwarded-for"] = f"{existing_forwarded_for}, {client_host}"
    elif client_host:
        headers["x-forwarded-for"] = client_host
    headers["x-forwarded-host"] = request.headers.get("host", "")
    headers["x-forwarded-proto"] = request.url.scheme
    return headers


def build_upstream_url(service: ServiceProxy, request_path: str, query: str) -> str:
    url = service.upstream_base_url + request_path
    if query:
        return f"{url}?{query}"
    return url


@asynccontextmanager
async def lifespan(app: FastAPI):
    timeout = httpx.Timeout(connect=10.0, read=30.0 * 60.0, write=30.0 * 60.0, pool=60.0)
    client = httpx.AsyncClient(timeout=timeout, follow_redirects=False)
    app.state.http_client = client
    try:
        yield
    finally:
        app.state.http_client = None
        await client.aclose()


app = FastAPI(
    title="Infumap GPU Gateway",
    version="0.1.0",
    lifespan=lifespan,
)


def proxy_client(request: Request) -> httpx.AsyncClient:
    client = getattr(request.app.state, "http_client", None)
    if client is None:
        raise RuntimeError("Gateway HTTP client is not initialized.")
    return client


async def health_probe(client: httpx.AsyncClient, service: ServiceProxy) -> dict[str, Any]:
    health_url = f"{service.upstream_base_url}/healthz"
    try:
        response = await client.get(health_url)
    except httpx.HTTPError as exc:
        return {
            "ok": False,
            "paths": list(service.public_paths),
            "upstream": service.upstream_base_url,
            "status_code": None,
            "detail": str(exc),
        }

    try:
        detail: Any = response.json()
    except ValueError:
        detail = response.text

    payload_ok = True
    if isinstance(detail, dict) and "ok" in detail:
        payload_ok = bool(detail["ok"])

    return {
        "ok": response.is_success and payload_ok,
        "paths": list(service.public_paths),
        "upstream": service.upstream_base_url,
        "status_code": response.status_code,
        "detail": detail,
    }


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "service": "infumap-gpu-gateway",
        "docs": "/docs",
        "health": "/healthz",
        "services": {
            name: {
                "paths": list(service.public_paths),
                "upstream": service.upstream_base_url,
            }
            for name, service in SERVICES.items()
        },
    }


@app.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    client = proxy_client(request)
    service_statuses: dict[str, Any] = {}
    overall_ok = True
    for name, service in SERVICES.items():
        status = await health_probe(client, service)
        service_statuses[name] = status
        overall_ok = overall_ok and bool(status["ok"])

    return JSONResponse(
        status_code=200 if overall_ok else 503,
        content={"ok": overall_ok, "services": service_statuses},
    )


def match_service_for_path(request_path: str) -> ServiceProxy:
    for service in SERVICES.values():
        if request_path in service.public_paths:
            return service
    raise HTTPException(status_code=404, detail=f"No GPU service is mapped for path '{request_path}'.")


async def proxy_to_service(request: Request, service: ServiceProxy, request_path: str) -> StreamingResponse:
    client = proxy_client(request)
    upstream_url = build_upstream_url(service, request_path, request.url.query)
    upstream_request = client.build_request(
        method=request.method,
        url=upstream_url,
        headers=forwarded_headers(request),
        content=request.stream(),
    )
    upstream_response = await client.send(upstream_request, stream=True)
    return StreamingResponse(
        upstream_response.aiter_raw(),
        status_code=upstream_response.status_code,
        headers=strip_hop_by_hop_headers(upstream_response.headers),
        background=BackgroundTask(upstream_response.aclose),
    )


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_service_subpath(request: Request, full_path: str) -> StreamingResponse:
    request_path = "/" + full_path.strip("/")
    service = match_service_for_path(request_path)
    return await proxy_to_service(request, service, request_path)
