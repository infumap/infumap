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
import math
import os
import platform
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from extractor import SERVICE_VERSION, PdfExtractor
from extraction_errors import (
    BackendUnavailableError,
    DocumentRejectedError,
    ExtractionTimeoutError,
    PDF_CONVERSION_TIMEOUT_ERROR_CODE,
    PDF_EXTRACTION_FAILED_ERROR_CODE,
    classify_document_rejection,
    is_resource_failure,
)

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
CONVERT_SEMAPHORE: asyncio.Semaphore | None = None
GPU_REQUEST_CONCURRENCY = 1
DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
DEFAULT_WORKER_SLOT_WAIT_TIMEOUT_SECS = 4.0 * 60.0 * 60.0
DEFAULT_CONVERSION_TIMEOUT_SECS = 60.0 * 60.0
# Set by the GPU gateway on every request it forwards, so the gateway's lock
# lease and this watchdog use the same limit.
CONVERSION_TIMEOUT_HEADER = "x-pdf-conversion-timeout-secs"
CONVERSION_TIMEOUT_EXIT_DELAY_SECS = 2.0


class UploadTooLargeError(Exception):
    pass


class ConvertResponse(BaseModel):
    success: bool
    file_name: str
    markdown: str
    metadata: dict[str, Any]
    duration_ms: int


def document_error_response(exc: DocumentRejectedError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "success": False,
            "error_code": exc.error_code,
            "error": exc.message,
            "metadata": {"error_code": exc.error_code},
        },
    )


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
        return max(1, int(raw))
    except ValueError:
        LOGGER.warning("Invalid integer for %s=%r; using %d", name, raw, default)
        return default


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Invalid float for %s=%r; using %s", name, raw, default)
        return default


def worker_slot_wait_timeout_secs() -> float:
    return max(
        0.001,
        env_float("TEXT_EXTRACTION_WORKER_SLOT_WAIT_TIMEOUT_SECS", DEFAULT_WORKER_SLOT_WAIT_TIMEOUT_SECS),
    )


def conversion_timeout_secs() -> float:
    return max(
        1.0,
        env_float("TEXT_EXTRACTION_CONVERSION_TIMEOUT_SECS", DEFAULT_CONVERSION_TIMEOUT_SECS),
    )


def conversion_timeout_secs_for_request(request: Request) -> float:
    raw = request.headers.get(CONVERSION_TIMEOUT_HEADER)
    if raw is None or raw.strip() == "":
        return conversion_timeout_secs()
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value) or value < 1.0:
        raise HTTPException(status_code=400, detail=f"{CONVERSION_TIMEOUT_HEADER} must be at least 1 second.")
    return value


def root_path() -> str:
    configured = os.environ.get("TEXT_EXTRACTION_ROOT_PATH", "").strip()
    if not configured or configured == "/":
        return ""
    return "/" + configured.strip("/")


def build_runtime_summary() -> list[str]:
    summary = [
        f"python={platform.python_version()}",
        f"platform={platform.platform()}",
        f"marker={package_version('marker-pdf')}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"torch_device_env={os.environ.get('TORCH_DEVICE', '<unset>')}",
        f"cuda_visible_devices={os.environ.get('CUDA_VISIBLE_DEVICES', '<unset>')}",
        f"inference_ram={os.environ.get('INFERENCE_RAM', '<unset>')}",
        f"max_concurrency={GPU_REQUEST_CONCURRENCY}",
        f"worker_slot_wait_timeout_secs={worker_slot_wait_timeout_secs()}",
        f"conversion_timeout_secs={conversion_timeout_secs()}",
        f"surya_guided_layout={os.environ.get('SURYA_GUIDED_LAYOUT', '<unset>')}",
        f"max_upload_bytes={max_upload_bytes()}",
    ]

    try:
        import torch

        summary.append(f"torch={torch.__version__}")
        summary.append(f"cuda_available={torch.cuda.is_available()}")
        if torch.cuda.is_available():
            summary.append(f"cuda_device_count={torch.cuda.device_count()}")
            cuda_devices = []
            for idx in range(torch.cuda.device_count()):
                props = torch.cuda.get_device_properties(idx)
                cuda_devices.append(
                    f"{idx}:{torch.cuda.get_device_name(idx)} ({props.total_memory / (1024 ** 3):.1f} GiB)"
                )
            summary.append(f"cuda_devices=[{', '.join(cuda_devices)}]")
        if hasattr(torch.backends, "mps"):
            summary.append(f"mps_available={torch.backends.mps.is_available()}")
    except Exception as exc:
        summary.append(f"torch_runtime_error={exc}")

    return summary


def clear_torch_cuda_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def reset_torch_cuda_peak_memory() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:
        pass


def torch_cuda_memory_summary() -> str | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None

        torch.cuda.synchronize()
        allocated_mib = torch.cuda.memory_allocated() / (1024 * 1024)
        reserved_mib = torch.cuda.memory_reserved() / (1024 * 1024)
        peak_allocated_mib = torch.cuda.max_memory_allocated() / (1024 * 1024)
        peak_reserved_mib = torch.cuda.max_memory_reserved() / (1024 * 1024)
        return (
            f"cuda_mem_allocated={allocated_mib:.0f}MiB "
            f"cuda_mem_reserved={reserved_mib:.0f}MiB "
            f"cuda_peak_allocated={peak_allocated_mib:.0f}MiB "
            f"cuda_peak_reserved={peak_reserved_mib:.0f}MiB"
        )
    except Exception as exc:
        return f"cuda_mem_error={exc}"


async def exit_process_after_delay(delay_secs: float, exit_code: int) -> None:
    await asyncio.sleep(delay_secs)
    os._exit(exit_code)


def schedule_conversion_timeout_exit(file_name: str, timeout_secs: float) -> None:
    if APP_STATE.get("conversion_timeout_exit_scheduled"):
        return
    APP_STATE["conversion_timeout_exit_scheduled"] = True
    extractor = APP_STATE.get("extractor")
    if extractor is not None:
        extractor.docling.cancel()
    LOGGER.error(
        "Text extraction conversion timeout triggered for file=%s (configured limit %.3f seconds); "
        "terminating service process so the supervisor can restart it.",
        file_name,
        timeout_secs,
    )
    asyncio.create_task(exit_process_after_delay(CONVERSION_TIMEOUT_EXIT_DELAY_SECS, 124))


@asynccontextmanager
async def lifespan(_: FastAPI):
    global CONVERT_SEMAPHORE
    extractor = PdfExtractor()
    LOGGER.info("Text extraction startup: %s", " ".join(build_runtime_summary()))
    try:
        extractor.load()
        APP_STATE["extractor"] = extractor
        CONVERT_SEMAPHORE = asyncio.Semaphore(GPU_REQUEST_CONCURRENCY)
        yield
    finally:
        CONVERT_SEMAPHORE = None
        APP_STATE.clear()
        extractor.close()


app = FastAPI(
    title="Infumap Text Extraction Service",
    version=SERVICE_VERSION,
    lifespan=lifespan,
    root_path=root_path(),
)


def max_upload_bytes() -> int:
    return max(1, env_int("TEXT_EXTRACTION_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES))


def rooted_path(request: Request, suffix: str) -> str:
    current_root = request.scope.get("root_path", "").rstrip("/")
    if not current_root:
        return suffix
    return f"{current_root}{suffix}"


def decode_header_value(value: bytes | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        decoded = value.decode("utf-8", errors="replace")
    else:
        decoded = str(value)
    normalized = decoded.strip()
    return normalized or None


def close_pdfium_object(value: Any) -> None:
    if value is None:
        return
    close = getattr(value, "close", None) or getattr(value, "__exit__", None)
    if not callable(close):
        return
    try:
        if getattr(close, "__name__", "") == "__exit__":
            close(None, None, None)
        else:
            close()
    except Exception:
        pass


def reject_unprocessable_pdf(file_bytes: bytes) -> None:
    try:
        import pypdfium2 as pdfium
    except (ImportError, OSError) as exc:
        raise BackendUnavailableError(f"PDFium is unavailable: {exc}") from exc

    pdf = None
    try:
        pdf = pdfium.PdfDocument(file_bytes)
    except Exception as exc:
        if is_resource_failure(str(exc)):
            raise BackendUnavailableError(f"PDFium failed: {exc}") from exc
        rejection = classify_document_rejection(exc)
        if rejection is None:
            return
        error_code, message = rejection
        raise DocumentRejectedError(error_code, message) from exc
    finally:
        close_pdfium_object(pdf)


def convert_file_bytes(file_bytes: bytes, file_name: str, deadline: float) -> ConvertResponse:
    started_at = time.perf_counter()
    file_size_bytes = len(file_bytes)
    LOGGER.info("Starting conversion: file=%s size_bytes=%d", file_name, file_size_bytes)
    reset_torch_cuda_peak_memory()
    reject_unprocessable_pdf(file_bytes)
    try:
        extractor: PdfExtractor = APP_STATE["extractor"]
        markdown, metadata = extractor.convert(file_bytes, file_name, deadline=deadline)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        page_count = metadata.get("page_count")
        page_stats = metadata.get("page_stats")
        if isinstance(page_stats, list):
            page_count = len(page_stats)
        cuda_memory = torch_cuda_memory_summary()
        LOGGER.info(
            "Completed conversion: file=%s size_bytes=%d duration_ms=%d markdown_chars=%d page_count=%s%s",
            file_name,
            file_size_bytes,
            duration_ms,
            len(markdown),
            page_count if page_count is not None else "unknown",
            f" {cuda_memory}" if cuda_memory else "",
        )

        return ConvertResponse(
            success=True,
            file_name=file_name,
            markdown=markdown,
            metadata=metadata,
            duration_ms=duration_ms,
        )
    except DocumentRejectedError as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        LOGGER.warning(
            "Rejected PDF: file=%s size_bytes=%d duration_ms=%d error_code=%s reason=%s",
            file_name,
            file_size_bytes,
            duration_ms,
            exc.error_code,
            exc.message,
            exc_info=exc.error_code == PDF_EXTRACTION_FAILED_ERROR_CODE,
        )
        raise
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        cuda_memory = torch_cuda_memory_summary()
        rejection = classify_document_rejection(exc)
        if rejection is not None:
            error_code, rejection_reason = rejection
            LOGGER.warning(
                "Skipping unprocessable PDF: file=%s size_bytes=%d duration_ms=%d error_code=%s reason=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                error_code,
                rejection_reason,
                f" {cuda_memory}" if cuda_memory else "",
            )
            raise DocumentRejectedError(error_code, rejection_reason) from exc
        LOGGER.exception(
            "Conversion failed: file=%s size_bytes=%d duration_ms=%d%s",
            file_name,
            file_size_bytes,
            duration_ms,
            f" {cuda_memory}" if cuda_memory else "",
        )
        raise exc
    finally:
        clear_torch_cuda_cache()


async def read_multipart_upload(request: Request) -> tuple[str, str | None, bytes]:
    content_type_header = request.headers.get("content-type", "")
    parsed_content_type, params = parse_options_header(content_type_header.encode("latin-1"))
    if parsed_content_type != b"multipart/form-data":
        raise HTTPException(status_code=400, detail="Expected multipart/form-data.")

    boundary = params.get(b"boundary")
    if not boundary:
        raise HTTPException(status_code=400, detail="Missing multipart boundary.")

    upload_limit = max_upload_bytes()
    body_limit = upload_limit + 1024 * 1024

    current_headers: dict[bytes, bytes] = {}
    header_name_parts: list[bytes] = []
    header_value_parts: list[bytes] = []
    collecting_target_file = False
    seen_target_file = False
    file_name: str | None = None
    file_content_type: str | None = None
    file_bytes = bytearray()

    def on_part_begin() -> None:
        nonlocal current_headers, collecting_target_file
        current_headers = {}
        collecting_target_file = False

    def on_header_begin() -> None:
        header_name_parts.clear()
        header_value_parts.clear()

    def on_header_field(data: bytes, start: int, end: int) -> None:
        header_name_parts.append(data[start:end])

    def on_header_value(data: bytes, start: int, end: int) -> None:
        header_value_parts.append(data[start:end])

    def on_header_end() -> None:
        if not header_name_parts:
            return
        header_name = b"".join(header_name_parts).strip().lower()
        header_value = b"".join(header_value_parts).strip()
        current_headers[header_name] = header_value

    def on_headers_finished() -> None:
        nonlocal collecting_target_file, file_name, file_content_type

        disposition = current_headers.get(b"content-disposition", b"")
        disposition_type, disposition_params = parse_options_header(disposition)
        if disposition_type != b"form-data":
            return

        current_field_name = decode_header_value(disposition_params.get(b"name"))
        if current_field_name != "file":
            return

        if seen_target_file:
            raise ValueError("Multipart request contained more than one 'file' part.")

        collecting_target_file = True
        current_file_name = decode_header_value(disposition_params.get(b"filename"))
        file_name = Path(current_file_name or "upload").name
        file_content_type = decode_header_value(current_headers.get(b"content-type"))

    def on_part_data(data: bytes, start: int, end: int) -> None:
        if not collecting_target_file:
            return
        chunk = data[start:end]
        if len(file_bytes) + len(chunk) > upload_limit:
            raise UploadTooLargeError(
                f"Uploaded PDF exceeds the in-memory limit of {upload_limit} bytes. "
                "Increase TEXT_EXTRACTION_MAX_UPLOAD_BYTES if needed."
            )
        file_bytes.extend(chunk)

    def on_part_end() -> None:
        nonlocal seen_target_file
        if collecting_target_file:
            seen_target_file = True

    parser = MultipartParser(
        boundary,
        callbacks={
            "on_part_begin": on_part_begin,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
            "on_header_begin": on_header_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
        },
        max_size=float(body_limit),
    )

    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            parser.write(chunk)
        parser.finalize()
    except UploadTooLargeError:
        raise
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse multipart upload: {exc}") from exc

    if not seen_target_file:
        raise HTTPException(status_code=422, detail="Missing multipart form field 'file'.")

    if not file_bytes:
        raise HTTPException(status_code=422, detail="Uploaded file was empty.")

    return file_name or "upload", file_content_type, bytes(file_bytes)


@app.get("/")
async def root(request: Request) -> dict[str, str]:
    return {
        "service": "infumap-text-extraction",
        "docs": rooted_path(request, "/docs"),
        "health": rooted_path(request, "/healthz"),
        "gpu_tools": rooted_path(request, "/gpu-tools"),
        "pdf_extract": rooted_path(request, "/pdf-extract"),
        "convert": rooted_path(request, "/convert"),
    }


@app.get("/gpu-tools")
async def gpu_tools() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "service": "infumap-pdf-extract",
        "endpoints": [
            {
                "id": "pdf_extract",
                "method": "POST",
                "path": "/pdf-extract",
                "description": "Extract Markdown text from an uploaded PDF.",
            },
        ],
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": "extractor" in APP_STATE and not APP_STATE.get("conversion_timeout_exit_scheduled", False)}


@app.post("/pdf-extract", response_model=ConvertResponse)
@app.post("/convert", response_model=ConvertResponse)
async def convert_upload(request: Request) -> ConvertResponse:
    request_started_at = time.perf_counter()
    try:
        conversion_timeout = conversion_timeout_secs_for_request(request)
        upload_started_at = time.perf_counter()
        file_name, content_type, upload_bytes = await read_multipart_upload(request)
        upload_size_bytes = len(upload_bytes)
        upload_duration_ms = int((time.perf_counter() - upload_started_at) * 1000)
        LOGGER.info(
            "Received in-memory text extraction upload: file=%s content_type=%s size_bytes=%d upload_ms=%d",
            file_name,
            content_type or "<unset>",
            upload_size_bytes,
            upload_duration_ms,
        )
        semaphore = CONVERT_SEMAPHORE
        if semaphore is None or APP_STATE.get("conversion_timeout_exit_scheduled"):
            raise HTTPException(status_code=503, detail="Text extraction service is not ready.")
        semaphore_wait_started_at = time.perf_counter()
        if semaphore.locked():
            LOGGER.info(
                "Text extraction request waiting for worker slot: file=%s size_bytes=%d",
                file_name,
                upload_size_bytes,
            )
        slot_wait_timeout_secs = worker_slot_wait_timeout_secs()
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=slot_wait_timeout_secs)
        except asyncio.TimeoutError as exc:
            semaphore_wait_ms = int((time.perf_counter() - semaphore_wait_started_at) * 1000)
            raise HTTPException(
                status_code=503,
                detail=f"Text extraction worker slot was busy for {semaphore_wait_ms} ms. Try again later.",
            ) from exc

        try:
            if APP_STATE.get("conversion_timeout_exit_scheduled"):
                raise HTTPException(status_code=503, detail="Text extraction worker is restarting.")
            semaphore_wait_ms = int((time.perf_counter() - semaphore_wait_started_at) * 1000)
            request_age_ms = int((time.perf_counter() - request_started_at) * 1000)
            LOGGER.info(
                "Dispatching text extraction conversion: file=%s size_bytes=%d request_age_ms=%d semaphore_wait_ms=%d "
                "conversion_timeout_secs=%g",
                file_name,
                upload_size_bytes,
                request_age_ms,
                semaphore_wait_ms,
                conversion_timeout,
            )
            try:
                return await asyncio.wait_for(
                    asyncio.to_thread(
                        convert_file_bytes, upload_bytes, file_name, time.monotonic() + conversion_timeout
                    ),
                    timeout=conversion_timeout,
                )
            except (asyncio.TimeoutError, ExtractionTimeoutError) as exc:
                schedule_conversion_timeout_exit(file_name, conversion_timeout)
                reason = str(exc) if isinstance(exc, ExtractionTimeoutError) else (
                    f"PDF conversion exceeded the {conversion_timeout:.0f} second timeout. "
                    "The PDF may be too large or complex for automatic extraction."
                )
                raise DocumentRejectedError(
                    PDF_CONVERSION_TIMEOUT_ERROR_CODE,
                    reason,
                ) from exc
        finally:
            semaphore.release()
    except BackendUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except UploadTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except DocumentRejectedError as exc:
        return document_error_response(exc)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
