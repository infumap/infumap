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
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.requests import ClientDisconnect

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

LOGGER = logging.getLogger("uvicorn.error")
DEFAULT_UPSTREAM_READ_WRITE_TIMEOUT_SECS = 30.0 * 60.0
PDF_EXTRACT_UPSTREAM_READ_WRITE_TIMEOUT_SECS = 4.0 * 60.0 * 60.0
PDF_EXTRACT_JOB_UPSTREAM_READ_WRITE_TIMEOUT_SECS = 24.0 * 60.0 * 60.0
DEFAULT_GLOBAL_GPU_LOCK_WAIT_TIMEOUT_SECS = 5.0 * 60.0
DEFAULT_GLOBAL_GPU_LOCK_LEASE_SECS = 60.0 * 60.0
PDF_EXTRACT_JOB_RESULT_RETENTION_SECS = 6.0 * 60.0 * 60.0


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Invalid float for %s=%r; using %s", name, raw, default)
        return default


def global_gpu_lock_wait_timeout_secs() -> float:
    return max(
        0.001,
        env_float("GPU_GATEWAY_LOCK_WAIT_TIMEOUT_SECS", DEFAULT_GLOBAL_GPU_LOCK_WAIT_TIMEOUT_SECS),
    )


def global_gpu_lock_lease_secs() -> float:
    return max(
        1.0,
        env_float("GPU_GATEWAY_LOCK_LEASE_SECS", DEFAULT_GLOBAL_GPU_LOCK_LEASE_SECS),
    )


def pdf_extract_job_upstream_timeout_secs() -> float:
    return max(
        1.0,
        env_float(
            "GPU_GATEWAY_PDF_EXTRACT_JOB_UPSTREAM_TIMEOUT_SECS",
            PDF_EXTRACT_JOB_UPSTREAM_READ_WRITE_TIMEOUT_SECS,
        ),
    )


@dataclass(frozen=True)
class ServiceProxy:
    service_name: str
    public_paths: tuple[str, ...]
    upstream_base_url: str
    upstream_path_overrides: dict[str, str] | None = None
    health_paths: tuple[str, ...] = ("/healthz",)
    upstream_read_write_timeout_secs: float = DEFAULT_UPSTREAM_READ_WRITE_TIMEOUT_SECS
    uses_global_gpu_lock: bool = True

    def upstream_path_for(self, public_path: str) -> str:
        if self.upstream_path_overrides and public_path in self.upstream_path_overrides:
            return self.upstream_path_overrides[public_path]
        return public_path


@dataclass
class PdfExtractJob:
    job_id: str
    request_body: bytes
    request_headers: dict[str, str]
    idempotency_key: str | None
    created_at: float
    updated_at: float
    status: str = "queued"
    wait_ms: int | None = None
    http_status: int | None = None
    response_body: bytes | None = None
    response_headers: dict[str, str] | None = None
    error: str | None = None


@dataclass(frozen=True)
class GpuLockLease:
    token: str
    service_name: str
    path: str
    method: str
    job_id: str | None
    acquired_at_unix_secs: float
    acquired_at_perf_secs: float
    wait_ms: int
    lease_secs: float


class GpuLockWaitTimeoutError(Exception):
    def __init__(self, wait_ms: int, holder: GpuLockLease | None) -> None:
        super().__init__("GPU gateway global lock wait timed out.")
        self.wait_ms = wait_ms
        self.holder = holder


class GlobalGpuLock:
    def __init__(self) -> None:
        self._condition = asyncio.Condition()
        self._lease: GpuLockLease | None = None

    def locked(self) -> bool:
        return self._lease is not None

    def holder(self) -> GpuLockLease | None:
        return self._lease

    def snapshot(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "enabled": True,
            "locked": self._lease is not None,
            "wait_timeout_secs": global_gpu_lock_wait_timeout_secs(),
            "lease_secs": global_gpu_lock_lease_secs(),
        }
        if self._lease is not None:
            payload["holder"] = gpu_lock_holder_payload(self._lease)
        return payload

    async def acquire(
        self,
        *,
        service_name: str,
        path: str,
        method: str,
        job_id: str | None,
        timeout_secs: float,
    ) -> GpuLockLease:
        wait_started_at = time.perf_counter()
        deadline = wait_started_at + timeout_secs
        async with self._condition:
            while True:
                now = time.perf_counter()
                existing = self._lease
                if existing is None:
                    return self._create_lease_locked(service_name, path, method, job_id, wait_started_at)

                held_secs = max(0.0, now - existing.acquired_at_perf_secs)
                if held_secs >= existing.lease_secs:
                    new_lease = self._create_lease_locked(service_name, path, method, job_id, wait_started_at)
                    LOGGER.error(
                        "GPU gateway global lock lease expired after %d ms; allowing new holder. "
                        "expired_holder=%s new_holder=%s",
                        int(held_secs * 1000),
                        describe_gpu_lock_holder(existing),
                        describe_gpu_lock_holder(new_lease),
                    )
                    self._condition.notify_all()
                    return new_lease

                remaining_secs = deadline - now
                if remaining_secs <= 0.0:
                    raise GpuLockWaitTimeoutError(int((now - wait_started_at) * 1000), existing)

                wait_secs = min(remaining_secs, max(0.001, existing.lease_secs - held_secs))
                try:
                    await asyncio.wait_for(self._condition.wait(), timeout=wait_secs)
                except asyncio.TimeoutError:
                    pass

    async def release(self, lease: GpuLockLease) -> bool:
        async with self._condition:
            if self._lease is None or self._lease.token != lease.token:
                return False
            self._lease = None
            self._condition.notify_all()
            return True

    def _create_lease_locked(
        self,
        service_name: str,
        path: str,
        method: str,
        job_id: str | None,
        wait_started_at: float,
    ) -> GpuLockLease:
        now_perf = time.perf_counter()
        lease = GpuLockLease(
            token=uuid.uuid4().hex,
            service_name=service_name,
            path=path,
            method=method,
            job_id=job_id,
            acquired_at_unix_secs=time.time(),
            acquired_at_perf_secs=now_perf,
            wait_ms=int((now_perf - wait_started_at) * 1000),
            lease_secs=global_gpu_lock_lease_secs(),
        )
        self._lease = lease
        return lease


def gpu_lock_holder_payload(lease: GpuLockLease) -> dict[str, Any]:
    return {
        "service": lease.service_name,
        "path": lease.path,
        "method": lease.method,
        "job_id": lease.job_id,
        "acquired_at_unix_secs": lease.acquired_at_unix_secs,
        "held_ms": int(max(0.0, time.perf_counter() - lease.acquired_at_perf_secs) * 1000),
        "wait_ms": lease.wait_ms,
        "lease_secs": lease.lease_secs,
    }


def describe_gpu_lock_holder(lease: GpuLockLease | None) -> str:
    if lease is None:
        return "<none>"
    payload = gpu_lock_holder_payload(lease)
    job_part = f" job_id={payload['job_id']}" if payload["job_id"] else ""
    return (
        f"service={payload['service']} path={payload['path']} method={payload['method']}"
        f"{job_part} held_ms={payload['held_ms']} lease_secs={payload['lease_secs']}"
    )


def upstream_base_url(names: tuple[str, ...], default_host: str, default_port: int) -> str:
    for name in names:
        configured = os.environ.get(name, "").strip()
        if configured:
            return configured.rstrip("/")
    return f"http://{default_host}:{default_port}"


def service_registry() -> dict[str, ServiceProxy]:
    services = [
        ServiceProxy(
            service_name="image_extract",
            public_paths=("/image-extract", "/tag"),
            upstream_base_url=upstream_base_url(
                ("GPU_IMAGE_EXTRACT_UPSTREAM_URL", "GPU_IMAGE_TAGGING_UPSTREAM_URL"),
                "127.0.0.1",
                8788,
            ),
        ),
        ServiceProxy(
            service_name="text_embed",
            public_paths=("/text-embed", "/embed"),
            upstream_base_url=upstream_base_url(
                ("GPU_TEXT_EMBED_UPSTREAM_URL", "GPU_TEXT_EMBEDDING_UPSTREAM_URL"),
                "127.0.0.1",
                8789,
            ),
            uses_global_gpu_lock=False,
        ),
        ServiceProxy(
            service_name="pdf_extract",
            public_paths=("/pdf-extract", "/convert"),
            upstream_base_url=upstream_base_url(
                ("GPU_PDF_EXTRACT_UPSTREAM_URL", "GPU_TEXT_EXTRACTION_UPSTREAM_URL"),
                "127.0.0.1",
                8790,
            ),
            upstream_read_write_timeout_secs=PDF_EXTRACT_UPSTREAM_READ_WRITE_TIMEOUT_SECS,
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
    url = service.upstream_base_url + service.upstream_path_for(request_path)
    if query:
        return f"{url}?{query}"
    return url


def should_buffer_request_body_before_gpu_lock(service: ServiceProxy, request_path: str, method: str) -> bool:
    return (
        service.service_name == "image_extract"
        and request_path in {"/image-extract", "/tag"}
        and method.upper() in {"POST", "PUT", "PATCH"}
    )


async def maybe_buffer_request_body_before_gpu_lock(
    request: Request,
    service: ServiceProxy,
    request_path: str,
) -> bytes | None:
    if not should_buffer_request_body_before_gpu_lock(service, request_path, request.method):
        return None

    try:
        body = await request.body()
    except ClientDisconnect as exc:
        LOGGER.info(
            "GPU gateway client disconnected while buffering request body before global lock: service=%s path=%s method=%s",
            service.service_name,
            request_path,
            request.method,
        )
        raise HTTPException(status_code=499, detail="Client disconnected while uploading request body.") from exc

    LOGGER.info(
        "GPU gateway buffered request body before global lock: service=%s path=%s method=%s bytes=%d",
        service.service_name,
        request_path,
        request.method,
        len(body),
    )
    return body


def upstream_timeout(read_write_timeout_secs: float) -> httpx.Timeout:
    return httpx.Timeout(connect=10.0, read=read_write_timeout_secs, write=read_write_timeout_secs, pool=60.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = httpx.AsyncClient(timeout=upstream_timeout(DEFAULT_UPSTREAM_READ_WRITE_TIMEOUT_SECS), follow_redirects=False)
    long_client = httpx.AsyncClient(
        timeout=upstream_timeout(PDF_EXTRACT_UPSTREAM_READ_WRITE_TIMEOUT_SECS),
        follow_redirects=False,
    )
    app.state.http_client = client
    app.state.long_http_client = long_client
    app.state.gpu_lock = GlobalGpuLock()
    app.state.pdf_extract_jobs = {}
    app.state.pdf_extract_job_keys = {}
    app.state.pdf_extract_jobs_lock = asyncio.Lock()
    try:
        yield
    finally:
        app.state.http_client = None
        app.state.long_http_client = None
        app.state.gpu_lock = None
        app.state.pdf_extract_jobs = None
        app.state.pdf_extract_job_keys = None
        app.state.pdf_extract_jobs_lock = None
        await client.aclose()
        await long_client.aclose()


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


def proxy_client_for_service(request: Request, service: ServiceProxy) -> httpx.AsyncClient:
    if service.upstream_read_write_timeout_secs <= DEFAULT_UPSTREAM_READ_WRITE_TIMEOUT_SECS:
        return proxy_client(request)

    client = getattr(request.app.state, "long_http_client", None)
    if client is None:
        raise RuntimeError("Gateway long-timeout HTTP client is not initialized.")
    return client


def gpu_lock(request: Request) -> GlobalGpuLock:
    lock = getattr(request.app.state, "gpu_lock", None)
    if lock is None:
        raise RuntimeError("Gateway GPU lock is not initialized.")
    return lock


def pdf_extract_jobs(request: Request) -> dict[str, PdfExtractJob]:
    jobs = getattr(request.app.state, "pdf_extract_jobs", None)
    if jobs is None:
        raise RuntimeError("Gateway PDF extraction job registry is not initialized.")
    return jobs


def pdf_extract_job_keys(request: Request) -> dict[str, str]:
    job_keys = getattr(request.app.state, "pdf_extract_job_keys", None)
    if job_keys is None:
        raise RuntimeError("Gateway PDF extraction job key registry is not initialized.")
    return job_keys


def pdf_extract_jobs_lock(request: Request) -> asyncio.Lock:
    lock = getattr(request.app.state, "pdf_extract_jobs_lock", None)
    if lock is None:
        raise RuntimeError("Gateway PDF extraction job lock is not initialized.")
    return lock


def pdf_extract_job_status_payload(job: PdfExtractJob) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "job_id": job.job_id,
        "status": job.status,
        "created_at_unix_secs": job.created_at,
        "updated_at_unix_secs": job.updated_at,
    }
    if job.wait_ms is not None:
        payload["wait_ms"] = job.wait_ms
    if job.http_status is not None:
        payload["http_status"] = job.http_status
    if job.error is not None:
        payload["error"] = job.error
    if job.status in {"succeeded", "failed"}:
        payload["result_path"] = f"/pdf-extract/jobs/{job.job_id}/result"
    return payload


async def cleanup_pdf_extract_jobs(request: Request) -> None:
    now = time.time()
    retention_secs = max(
        60.0,
        env_float("GPU_GATEWAY_PDF_EXTRACT_JOB_RESULT_RETENTION_SECS", PDF_EXTRACT_JOB_RESULT_RETENTION_SECS),
    )
    jobs = pdf_extract_jobs(request)
    job_keys = pdf_extract_job_keys(request)
    lock = pdf_extract_jobs_lock(request)
    async with lock:
        expired_job_ids = [
            job_id
            for job_id, job in jobs.items()
            if job.status in {"succeeded", "failed"} and now - job.updated_at > retention_secs
        ]
        for job_id in expired_job_ids:
            job = jobs.pop(job_id, None)
            if job and job.idempotency_key:
                job_keys.pop(job.idempotency_key, None)


async def update_pdf_extract_job(request: Request, job_id: str, **updates: Any) -> None:
    lock = pdf_extract_jobs_lock(request)
    async with lock:
        job = pdf_extract_jobs(request).get(job_id)
        if job is None:
            return
        for key, value in updates.items():
            setattr(job, key, value)
        job.updated_at = time.time()


async def run_pdf_extract_job(request: Request, job_id: str) -> None:
    service = SERVICES["pdf_extract"]
    lock = gpu_lock(request)
    client = proxy_client_for_service(request, service)
    async with pdf_extract_jobs_lock(request):
        job = pdf_extract_jobs(request).get(job_id)
        if job is None:
            return
        request_body = job.request_body
        request_headers = job.request_headers

    wait_started_at = time.perf_counter()
    lock_lease: GpuLockLease | None = None
    try:
        if lock.locked():
            LOGGER.info(
                "GPU gateway async PDF job waiting for global lock: job_id=%s path=/pdf-extract holder=%s",
                job_id,
                describe_gpu_lock_holder(lock.holder()),
            )
        try:
            lock_lease = await lock.acquire(
                service_name=service.service_name,
                path="/pdf-extract",
                method="POST",
                job_id=job_id,
                timeout_secs=global_gpu_lock_wait_timeout_secs(),
            )
        except GpuLockWaitTimeoutError as exc:
            wait_ms = exc.wait_ms
            await update_pdf_extract_job(
                request,
                job_id,
                status="failed",
                wait_ms=wait_ms,
                http_status=503,
                error=(
                    f"GPU gateway global lock was busy for {wait_ms} ms while waiting for async PDF extraction. "
                    f"Current holder: {describe_gpu_lock_holder(exc.holder)}."
                ),
                request_body=b"",
            )
            return

        wait_ms = int((time.perf_counter() - wait_started_at) * 1000)
        await update_pdf_extract_job(request, job_id, status="running", wait_ms=wait_ms)
        LOGGER.info("GPU gateway running async PDF extraction job: job_id=%s wait_ms=%d", job_id, wait_ms)
        upstream_url = service.upstream_base_url + service.upstream_path_for("/pdf-extract")
        upstream_response = await client.post(
            upstream_url,
            headers=request_headers,
            content=request_body,
            timeout=upstream_timeout(pdf_extract_job_upstream_timeout_secs()),
        )
        response_body = upstream_response.content
        await update_pdf_extract_job(
            request,
            job_id,
            status="succeeded" if upstream_response.is_success else "failed",
            http_status=upstream_response.status_code,
            response_body=response_body,
            response_headers=strip_hop_by_hop_headers(upstream_response.headers),
            request_body=b"",
        )
        LOGGER.info(
            "GPU gateway finished async PDF extraction job: job_id=%s status=%s upstream_status=%d bytes=%d",
            job_id,
            "succeeded" if upstream_response.is_success else "failed",
            upstream_response.status_code,
            len(response_body),
        )
    except httpx.HTTPError as exc:
        await update_pdf_extract_job(
            request,
            job_id,
            status="failed",
            http_status=503,
            error=f"Upstream GPU service 'pdf_extract' is unavailable: {exc}",
            request_body=b"",
        )
    except Exception as exc:
        LOGGER.exception("GPU gateway async PDF extraction job failed unexpectedly: job_id=%s", job_id)
        await update_pdf_extract_job(
            request,
            job_id,
            status="failed",
            http_status=500,
            error=str(exc),
            request_body=b"",
        )
    finally:
        if lock_lease is not None:
            if await lock.release(lock_lease):
                LOGGER.info("GPU gateway released global lock: service=pdf_extract path=/pdf-extract job_id=%s", job_id)
            else:
                LOGGER.warning(
                    "GPU gateway async PDF job finished after its global lock lease was no longer current: %s",
                    describe_gpu_lock_holder(lock_lease),
                )


async def health_probe(client: httpx.AsyncClient, service: ServiceProxy) -> dict[str, Any]:
    first_error: str | None = None
    response: httpx.Response | None = None
    response_health_url = ""
    health_url = ""

    for health_path in service.health_paths:
        health_url = f"{service.upstream_base_url}{health_path}"
        try:
            candidate = await client.get(health_url)
        except httpx.HTTPError as exc:
            if first_error is None:
                first_error = str(exc)
            continue

        if candidate.is_success:
            response = candidate
            response_health_url = health_url
            break
        if response is None:
            response = candidate
            response_health_url = health_url

    if response is None:
        return {
            "ok": False,
            "paths": list(service.public_paths),
            "upstream": service.upstream_base_url,
            "health_url": health_url,
            "status_code": None,
            "detail": first_error or "No health endpoint could be reached.",
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
        "health_url": response_health_url,
        "status_code": response.status_code,
        "detail": detail,
    }


@app.get("/")
async def root(request: Request) -> dict[str, Any]:
    lock = gpu_lock(request)
    return {
        "service": "infumap-gpu-gateway",
        "docs": "/docs",
        "health": "/healthz",
        "pdf_extract_jobs": "/pdf-extract/jobs",
        "global_gpu_lock": lock.snapshot(),
        "services": {
            name: {
                "paths": list(service.public_paths),
                "upstream": service.upstream_base_url,
                "upstream_read_write_timeout_secs": service.upstream_read_write_timeout_secs,
                "uses_global_gpu_lock": service.uses_global_gpu_lock,
            }
            for name, service in SERVICES.items()
        },
    }


@app.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    client = proxy_client(request)
    lock = gpu_lock(request)
    service_statuses: dict[str, Any] = {}
    overall_ok = True
    for name, service in SERVICES.items():
        status = await health_probe(client, service)
        service_statuses[name] = status
        overall_ok = overall_ok and bool(status["ok"])

    return JSONResponse(
        status_code=200 if overall_ok else 503,
        content={
            "ok": overall_ok,
            "global_gpu_lock": lock.snapshot(),
            "services": service_statuses,
        },
    )


@app.post("/pdf-extract/jobs")
async def submit_pdf_extract_job(request: Request) -> JSONResponse:
    await cleanup_pdf_extract_jobs(request)
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type.lower():
        raise HTTPException(status_code=400, detail="Expected multipart/form-data.")

    request_body = await request.body()
    if not request_body:
        raise HTTPException(status_code=422, detail="Request body was empty.")

    idempotency_key = request.headers.get("idempotency-key") or request.headers.get("x-infumap-job-key")
    lock = pdf_extract_jobs_lock(request)
    async with lock:
        jobs = pdf_extract_jobs(request)
        job_keys = pdf_extract_job_keys(request)
        if idempotency_key:
            existing_job_id = job_keys.get(idempotency_key)
            existing_job = jobs.get(existing_job_id) if existing_job_id else None
            if existing_job is not None:
                if existing_job.status == "failed" and existing_job.http_status not in {413, 422}:
                    jobs.pop(existing_job.job_id, None)
                    job_keys.pop(idempotency_key, None)
                else:
                    return JSONResponse(
                        status_code=200 if existing_job.status in {"succeeded", "failed"} else 202,
                        content=pdf_extract_job_status_payload(existing_job),
                    )

        job_id = uuid.uuid4().hex
        now = time.time()
        job = PdfExtractJob(
            job_id=job_id,
            request_body=request_body,
            request_headers=forwarded_headers(request),
            idempotency_key=idempotency_key,
            created_at=now,
            updated_at=now,
        )
        jobs[job_id] = job
        if idempotency_key:
            job_keys[idempotency_key] = job_id

    LOGGER.info(
        "GPU gateway accepted async PDF extraction job: job_id=%s bytes=%d idempotency_key=%s",
        job_id,
        len(request_body),
        "<set>" if idempotency_key else "<unset>",
    )
    asyncio.create_task(run_pdf_extract_job(request, job_id))
    return JSONResponse(status_code=202, content=pdf_extract_job_status_payload(job))


@app.get("/pdf-extract/jobs/{job_id}")
async def get_pdf_extract_job(request: Request, job_id: str) -> JSONResponse:
    async with pdf_extract_jobs_lock(request):
        job = pdf_extract_jobs(request).get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"PDF extraction job '{job_id}' was not found.")
        payload = pdf_extract_job_status_payload(job)
    return JSONResponse(status_code=200, content=payload)


@app.get("/pdf-extract/jobs/{job_id}/result")
async def get_pdf_extract_job_result(request: Request, job_id: str) -> Response:
    async with pdf_extract_jobs_lock(request):
        job = pdf_extract_jobs(request).get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"PDF extraction job '{job_id}' was not found.")
        if job.status not in {"succeeded", "failed"}:
            raise HTTPException(status_code=425, detail=f"PDF extraction job '{job_id}' is still {job.status}.")
        body = job.response_body
        headers = dict(job.response_headers or {})
        status_code = job.http_status or (200 if job.status == "succeeded" else 500)
        error = job.error

    if body is None:
        return JSONResponse(status_code=status_code, content={"detail": error or "PDF extraction job has no result body."})

    media_type = headers.pop("content-type", "application/json")
    headers.pop("content-length", None)
    headers.pop("content-encoding", None)
    return Response(content=body, status_code=status_code, headers=headers, media_type=media_type)


def match_service_for_path(request_path: str) -> ServiceProxy:
    for service in SERVICES.values():
        if request_path in service.public_paths:
            return service
    raise HTTPException(status_code=404, detail=f"No GPU service is mapped for path '{request_path}'.")


async def proxy_to_service(request: Request, service: ServiceProxy, request_path: str) -> StreamingResponse:
    client = proxy_client_for_service(request, service)
    lock = gpu_lock(request) if service.uses_global_gpu_lock else None
    upstream_url = build_upstream_url(service, request_path, request.url.query)
    buffered_request_body = await maybe_buffer_request_body_before_gpu_lock(request, service, request_path)
    upstream_request = client.build_request(
        method=request.method,
        url=upstream_url,
        headers=forwarded_headers(request),
        content=buffered_request_body if buffered_request_body is not None else request.stream(),
    )
    wait_started_at = time.perf_counter()
    if lock is not None and lock.locked():
        LOGGER.info(
            "GPU gateway request waiting for global lock: service=%s path=%s method=%s holder=%s",
            service.service_name,
            request_path,
            request.method,
            describe_gpu_lock_holder(lock.holder()),
        )
    lock_lease: GpuLockLease | None = None
    upstream_response: httpx.Response | None = None
    try:
        if lock is not None:
            try:
                lock_lease = await lock.acquire(
                    service_name=service.service_name,
                    path=request_path,
                    method=request.method,
                    job_id=None,
                    timeout_secs=global_gpu_lock_wait_timeout_secs(),
                )
            except GpuLockWaitTimeoutError as exc:
                wait_ms = exc.wait_ms
                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"GPU gateway global lock was busy for {wait_ms} ms while waiting for "
                        f"'{service.service_name}'. Current holder: {describe_gpu_lock_holder(exc.holder)}. "
                        "Try again later."
                    ),
                ) from exc
        wait_ms = int((time.perf_counter() - wait_started_at) * 1000)
        LOGGER.info(
            "GPU gateway forwarding request: service=%s path=%s method=%s wait_ms=%d global_lock=%s",
            service.service_name,
            request_path,
            request.method,
            wait_ms,
            "on" if lock is not None else "off",
        )
        upstream_response = await client.send(upstream_request, stream=True)
        response = StreamingResponse(
            stream_upstream_response_and_release_lock(
                upstream_response,
                lock,
                lock_lease,
                service.service_name,
                request_path,
            ),
            status_code=upstream_response.status_code,
            headers=strip_hop_by_hop_headers(upstream_response.headers),
        )
        lock_lease = None
        return response
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Upstream GPU service '{service.service_name}' is unavailable: {exc}",
        ) from exc
    finally:
        if lock_lease is not None:
            if upstream_response is not None:
                await upstream_response.aclose()
            if lock is not None:
                if await lock.release(lock_lease):
                    LOGGER.info("GPU gateway released global lock: service=%s path=%s", service.service_name, request_path)
                else:
                    LOGGER.warning(
                        "GPU gateway request finished after its global lock lease was no longer current: %s",
                        describe_gpu_lock_holder(lock_lease),
                    )


async def stream_upstream_response_and_release_lock(
    upstream_response: httpx.Response,
    lock: GlobalGpuLock | None,
    lock_lease: GpuLockLease | None,
    service_name: str,
    request_path: str,
) -> AsyncIterator[bytes]:
    try:
        async for chunk in upstream_response.aiter_raw():
            yield chunk
    finally:
        try:
            await upstream_response.aclose()
        finally:
            if lock is not None and lock_lease is not None:
                if await lock.release(lock_lease):
                    LOGGER.info("GPU gateway released global lock: service=%s path=%s", service_name, request_path)
                else:
                    LOGGER.warning(
                        "GPU gateway response stream finished after its global lock lease was no longer current: %s",
                        describe_gpu_lock_holder(lock_lease),
                    )


@app.api_route(
    "/{full_path:path}",
    methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
)
async def proxy_service_subpath(request: Request, full_path: str) -> StreamingResponse:
    request_path = "/" + full_path.strip("/")
    service = match_service_for_path(request_path)
    return await proxy_to_service(request, service, request_path)
