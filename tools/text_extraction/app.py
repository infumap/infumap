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
from contextlib import asynccontextmanager, contextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
CONVERT_SEMAPHORE: asyncio.Semaphore | None = None
GPU_REQUEST_CONCURRENCY = 1
PDFTEXT_WORKERS = 1
DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024


class DocumentRejectedError(Exception):
    pass


class UploadTooLargeError(Exception):
    pass


class ConvertResponse(BaseModel):
    success: bool
    file_name: str
    markdown: str
    metadata: dict[str, Any]
    duration_ms: int


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
        f"pdftext_workers={PDFTEXT_WORKERS}",
        f"use_llm={'yes' if os.environ.get('GOOGLE_API_KEY') else 'no'}",
        f"max_upload_bytes={max_upload_bytes()}",
        f"memfd_supported={memfd_supported()}",
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


def _device_strings(value: Any, seen: set[int]) -> set[str]:
    obj_id = id(value)
    if obj_id in seen:
        return set()
    seen.add(obj_id)

    devices: set[str] = set()

    device_attr = getattr(value, "device", None)
    if device_attr is not None and not callable(device_attr):
        devices.add(str(device_attr))

    parameters = getattr(value, "parameters", None)
    if callable(parameters):
        try:
            first_param = next(parameters())
        except Exception:
            first_param = None
        if first_param is not None and hasattr(first_param, "device"):
            devices.add(str(first_param.device))

    if isinstance(value, dict):
        for child in value.values():
            devices.update(_device_strings(child, seen))
    elif isinstance(value, (list, tuple, set)):
        for child in value:
            devices.update(_device_strings(child, seen))

    for attr_name in ("model", "encoder", "decoder", "processor", "recognition_model", "detection_model", "predictor"):
        child = getattr(value, attr_name, None)
        if child is not None:
            devices.update(_device_strings(child, seen))

    return devices


def summarize_loaded_models(models: dict[str, Any]) -> str:
    parts = []
    for name, model in sorted(models.items()):
        devices = sorted(_device_strings(model, set()))
        device_summary = ", ".join(devices) if devices else "device=unknown"
        parts.append(f"{name}[{device_summary}]")
    return ", ".join(parts) if parts else "<none>"


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


@asynccontextmanager
async def lifespan(_: FastAPI):
    global CONVERT_SEMAPHORE
    config = build_config()
    CONVERT_SEMAPHORE = asyncio.Semaphore(GPU_REQUEST_CONCURRENCY)
    LOGGER.info("Text extraction startup: %s", " ".join(build_runtime_summary()))
    LOGGER.info(
        "Text extraction config: force_ocr=%s paginate_output=%s use_llm=%s output_format=%s pdftext_workers=%s",
        config["force_ocr"],
        config["paginate_output"],
        config["use_llm"],
        config["output_format"],
        config["pdftext_workers"],
    )
    started_at = time.perf_counter()
    APP_STATE["models"] = create_model_dict()
    load_duration_ms = int((time.perf_counter() - started_at) * 1000)
    LOGGER.info(
        "Marker models loaded in %d ms: %s",
        load_duration_ms,
        summarize_loaded_models(APP_STATE["models"]),
    )
    yield
    APP_STATE.clear()
    CONVERT_SEMAPHORE = None


app = FastAPI(
    title="Infumap Text Extraction Service",
    version="0.1.0",
    lifespan=lifespan,
)


def build_config() -> dict[str, Any]:
    return {
        "force_ocr": False,
        "paginate_output": True,
        "use_llm": bool(os.environ.get("GOOGLE_API_KEY")),
        "output_format": "markdown",
        "pdftext_workers": PDFTEXT_WORKERS,
    }


def max_upload_bytes() -> int:
    return max(1, env_int("TEXT_EXTRACTION_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES))


def memfd_supported() -> bool:
    return hasattr(os, "memfd_create") and Path("/proc/self/fd").is_dir()


def decode_header_value(value: bytes | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        decoded = value.decode("utf-8", errors="replace")
    else:
        decoded = str(value)
    normalized = decoded.strip()
    return normalized or None


def metadata_to_dict(metadata: Any) -> dict[str, Any]:
    if metadata is None:
        return {}
    if hasattr(metadata, "model_dump"):
        value = metadata.model_dump()
        return value if isinstance(value, dict) else {"value": value}
    if isinstance(metadata, dict):
        return metadata
    return {"value": metadata}


def classify_document_rejection(exc: Exception) -> str | None:
    message = str(exc).lower()
    if "incorrect password" in message or "password error" in message:
        return "Password-protected PDFs are not supported."
    if "failed to load document" in message and "data format error" in message:
        return "The PDF appears to be malformed or corrupted and could not be opened by PDFium."
    return None


@contextmanager
def open_in_memory_pdf_path(file_name: str, file_bytes: bytes):
    if not memfd_supported():
        raise RuntimeError(
            "Anonymous in-memory files are not supported on this platform. "
            "This service now requires Linux memfd support to avoid disk writes."
        )

    safe_name = Path(file_name or "upload").stem or "upload"
    fd = os.memfd_create(f"infumap-pdf-{safe_name[:32]}-{os.getpid()}", getattr(os, "MFD_CLOEXEC", 0))
    try:
        remaining = memoryview(file_bytes)
        while remaining:
            written = os.write(fd, remaining)
            remaining = remaining[written:]
        yield f"/proc/self/fd/{fd}"
    finally:
        os.close(fd)


def convert_file_bytes(file_bytes: bytes, file_name: str) -> ConvertResponse:
    started_at = time.perf_counter()
    file_size_bytes = len(file_bytes)
    LOGGER.info("Starting conversion: file=%s size_bytes=%d", file_name, file_size_bytes)
    reset_torch_cuda_peak_memory()
    try:
        config_parser = ConfigParser(build_config())
        converter = PdfConverter(
            config=config_parser.generate_config_dict(),
            artifact_dict=APP_STATE["models"],
            processor_list=config_parser.get_processors(),
            renderer=config_parser.get_renderer(),
            llm_service=config_parser.get_llm_service(),
        )
        with open_in_memory_pdf_path(file_name, file_bytes) as file_path:
            rendered = converter(file_path)
        markdown, _, _ = text_from_rendered(rendered)
        metadata = metadata_to_dict(rendered.metadata)
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        page_count = None
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
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        cuda_memory = torch_cuda_memory_summary()
        rejection_reason = classify_document_rejection(exc)
        if rejection_reason is not None:
            LOGGER.warning(
                "Skipping unprocessable PDF: file=%s size_bytes=%d duration_ms=%d reason=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                rejection_reason,
                f" {cuda_memory}" if cuda_memory else "",
            )
            raise DocumentRejectedError(rejection_reason) from exc
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
    current_field_name: str | None = None
    current_file_name: str | None = None
    current_content_type: str | None = None
    collecting_target_file = False
    seen_target_file = False
    file_name: str | None = None
    file_content_type: str | None = None
    file_bytes = bytearray()

    def on_part_begin() -> None:
        nonlocal current_headers, current_field_name, current_file_name, current_content_type, collecting_target_file
        current_headers = {}
        current_field_name = None
        current_file_name = None
        current_content_type = None
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
        nonlocal current_field_name, current_file_name, current_content_type
        nonlocal collecting_target_file, seen_target_file, file_name, file_content_type

        disposition = current_headers.get(b"content-disposition", b"")
        disposition_type, disposition_params = parse_options_header(disposition)
        if disposition_type != b"form-data":
            return

        current_field_name = decode_header_value(disposition_params.get(b"name"))
        current_file_name = decode_header_value(disposition_params.get(b"filename"))
        current_content_type = decode_header_value(current_headers.get(b"content-type"))

        if current_field_name != "file":
            return

        if seen_target_file:
            raise ValueError("Multipart request contained more than one 'file' part.")

        collecting_target_file = True
        file_name = Path(current_file_name or "upload").name
        file_content_type = current_content_type

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
async def root() -> dict[str, str]:
    return {
        "service": "infumap-text-extraction",
        "docs": "/docs",
        "health": "/healthz",
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": "models" in APP_STATE}


@app.post("/convert", response_model=ConvertResponse)
async def convert_upload(request: Request) -> ConvertResponse:
    request_started_at = time.perf_counter()
    try:
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
        if semaphore is None:
            raise HTTPException(status_code=503, detail="Text extraction service is not ready.")
        semaphore_wait_started_at = time.perf_counter()
        if semaphore.locked():
            LOGGER.info(
                "Text extraction request waiting for worker slot: file=%s size_bytes=%d",
                file_name,
                upload_size_bytes,
            )
        async with semaphore:
            semaphore_wait_ms = int((time.perf_counter() - semaphore_wait_started_at) * 1000)
            request_age_ms = int((time.perf_counter() - request_started_at) * 1000)
            LOGGER.info(
                "Dispatching text extraction conversion: file=%s size_bytes=%d request_age_ms=%d semaphore_wait_ms=%d",
                file_name,
                upload_size_bytes,
                request_age_ms,
                semaphore_wait_ms,
            )
            return await asyncio.to_thread(convert_file_bytes, upload_bytes, file_name)
    except UploadTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except DocumentRejectedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
