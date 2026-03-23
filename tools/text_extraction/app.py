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
import ctypes
import logging
import os
import platform
import time
from contextlib import asynccontextmanager, contextmanager
from typing import List
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from ftfy import fix_text
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from marker.config.parser import ConfigParser
from marker.builders.document import DocumentBuilder
from marker.builders.line import LineBuilder
from marker.builders.ocr import OcrBuilder
from marker.builders.structure import StructureBuilder
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered
from marker.providers.pdf import PdfProvider, ProviderOutput, PolygonBox, get_block_class, BlockTypes

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
CONVERT_SEMAPHORE: asyncio.Semaphore | None = None
GPU_REQUEST_CONCURRENCY = 1
PDFTEXT_WORKERS = 1
DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024
LIBC = ctypes.CDLL(None, use_errno=True)
SYS_MEMFD_CREATE_BY_ARCH = {
    "x86_64": 319,
    "aarch64": 279,
    "arm64": 279,
}


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
        f"o_tmpfile_supported={o_tmpfile_supported()}",
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


def raw_memfd_supported() -> bool:
    return hasattr(LIBC, "memfd_create") or platform.machine().lower() in SYS_MEMFD_CREATE_BY_ARCH


def memfd_supported() -> bool:
    return hasattr(os, "memfd_create") or raw_memfd_supported()


def o_tmpfile_supported() -> bool:
    return getattr(os, "O_TMPFILE", None) is not None and Path("/dev/shm").is_dir()


def create_memfd(file_name: str) -> int:
    safe_name = (Path(file_name or "upload").stem or "upload")[:32]
    flags = getattr(os, "MFD_CLOEXEC", 0)
    name = f"infumap-pdf-{safe_name}-{os.getpid()}"

    if hasattr(os, "memfd_create"):
        return os.memfd_create(name, flags)

    encoded_name = name.encode("utf-8", errors="ignore")
    if hasattr(LIBC, "memfd_create"):
        fd = LIBC.memfd_create(ctypes.c_char_p(encoded_name), ctypes.c_uint(flags))
        if fd >= 0:
            return fd
        errno_value = ctypes.get_errno()
        raise OSError(errno_value, os.strerror(errno_value))

    syscall_nr = SYS_MEMFD_CREATE_BY_ARCH.get(platform.machine().lower())
    if syscall_nr is None:
        raise OSError(None, f"memfd_create syscall number is unknown for architecture '{platform.machine()}'.")
    fd = LIBC.syscall(ctypes.c_long(syscall_nr), ctypes.c_char_p(encoded_name), ctypes.c_uint(flags))
    if fd >= 0:
        return int(fd)
    errno_value = ctypes.get_errno()
    raise OSError(errno_value, os.strerror(errno_value))


def create_o_tmpfile_fd() -> int:
    flags = getattr(os, "O_TMPFILE", None)
    if flags is None:
        raise OSError(None, "O_TMPFILE is not available in this Python runtime.")
    return os.open("/dev/shm", os.O_RDWR | flags, 0o600)


def fd_path_candidates(fd: int) -> list[str]:
    pid = os.getpid()
    return [
        f"/proc/self/fd/{fd}",
        f"/proc/{pid}/fd/{fd}",
        f"/dev/fd/{fd}",
    ]


def resolve_fd_path(fd: int) -> str:
    for candidate in fd_path_candidates(fd):
        try:
            with open(candidate, "rb") as handle:
                handle.read(0)
            return candidate
        except OSError:
            continue
    raise RuntimeError(
        "Anonymous in-memory files are available, but this platform does not expose a usable "
        "file-descriptor path for Marker. Tried: "
        + ", ".join(fd_path_candidates(fd))
    )


def create_anonymous_pdf_fd(file_name: str) -> tuple[int, str]:
    errors: list[str] = []

    try:
        return create_memfd(file_name), "memfd"
    except OSError as exc:
        errors.append(f"memfd: {exc}")

    try:
        return create_o_tmpfile_fd(), "o_tmpfile:/dev/shm"
    except OSError as exc:
        errors.append(f"o_tmpfile: {exc}")

    raise RuntimeError(
        "Could not create an anonymous temporary file for Marker without using a named disk file. "
        + "Tried "
        + "; ".join(errors)
    )


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


class InMemoryPdfProvider(PdfProvider):
    def __init__(self, file_bytes: bytes, file_name: str, config=None):
        self.file_bytes = file_bytes
        self.in_memory_name = file_name
        super().__init__(file_name, config)

    @contextmanager
    def get_doc(self):
        doc = None
        try:
            import pypdfium2 as pdfium

            doc = pdfium.PdfDocument(self.file_bytes)
            if self.flatten_pdf:
                doc.init_forms()
            yield doc
        finally:
            if doc:
                doc.close()

    def pdftext_extraction(self, doc):
        from pdftext.extraction import dictionary_output

        page_lines = {}
        page_char_blocks = dictionary_output(
            self.file_bytes,
            page_range=self.page_range,
            keep_chars=self.keep_chars,
            workers=self.pdftext_workers,
            flatten_pdf=self.flatten_pdf,
            quote_loosebox=False,
            disable_links=self.disable_links,
        )
        self.page_bboxes = {
            page_id: [0, 0, page["width"], page["height"]]
            for page_id, page in zip(self.page_range, page_char_blocks)
        }
        SpanClass = get_block_class(BlockTypes.Span)
        LineClass = get_block_class(BlockTypes.Line)
        CharClass = get_block_class(BlockTypes.Char)

        for page in page_char_blocks:
            page_id = page["page"]
            lines: List[ProviderOutput] = []
            if not self.check_page(page_id, doc):
                continue
            for block in page["blocks"]:
                for line in block["lines"]:
                    spans = []
                    chars = []
                    for span in line["spans"]:
                        if not span["text"]:
                            continue
                        font_formats = self.font_flags_to_format(span["font"]["flags"]).union(
                            self.font_names_to_format(span["font"]["name"])
                        )
                        font_name = span["font"]["name"] or "Unknown"
                        font_weight = span["font"]["weight"] or 0
                        font_size = span["font"]["size"] or 0
                        polygon = PolygonBox.from_bbox(span["bbox"], ensure_nonzero_area=True)
                        superscript = span.get("superscript", False)
                        subscript = span.get("subscript", False)
                        text = self.normalize_spaces(fix_text(span["text"]))
                        if superscript or subscript:
                            text = text.strip()
                        spans.append(
                            SpanClass(
                                polygon=polygon,
                                text=text,
                                font=font_name,
                                font_weight=font_weight,
                                font_size=font_size,
                                minimum_position=span["char_start_idx"],
                                maximum_position=span["char_end_idx"],
                                formats=list(font_formats),
                                page_id=page_id,
                                text_extraction_method="pdftext",
                                url=span.get("url"),
                                has_superscript=superscript,
                                has_subscript=subscript,
                            )
                        )
                        if self.keep_chars:
                            span_chars = [
                                CharClass(
                                    text=char["char"],
                                    polygon=PolygonBox.from_bbox(char["bbox"], ensure_nonzero_area=True),
                                    idx=char["char_idx"],
                                )
                                for char in span["chars"]
                            ]
                            chars.append(span_chars)
                        else:
                            chars.append([])
                    polygon = PolygonBox.from_bbox(line["bbox"], ensure_nonzero_area=True)
                    assert len(spans) == len(chars), (
                        f"Spans and chars length mismatch on page {page_id}: {len(spans)} spans, {len(chars)} chars"
                    )
                    lines.append(
                        ProviderOutput(
                            line=LineClass(polygon=polygon, page_id=page_id),
                            spans=spans,
                            chars=chars,
                        )
                    )
            if self.check_line_spans(lines):
                page_lines[page_id] = lines
            self.page_refs[page_id] = []
            if page_refs := page.get("refs", None):
                self.page_refs[page_id] = page_refs

        return page_lines


class InMemoryPdfConverter(PdfConverter):
    def build_document_from_bytes(self, file_bytes: bytes, file_name: str):
        layout_builder = self.resolve_dependencies(self.layout_builder_class)
        line_builder = self.resolve_dependencies(LineBuilder)
        ocr_builder = self.resolve_dependencies(OcrBuilder)
        provider = InMemoryPdfProvider(file_bytes, file_name, self.config)
        document = DocumentBuilder(self.config)(
            provider,
            layout_builder,
            line_builder,
            ocr_builder,
        )
        structure_builder_cls = self.resolve_dependencies(StructureBuilder)
        structure_builder_cls(document)
        for processor in self.processor_list:
            processor(document)
        return document

    def convert_bytes(self, file_bytes: bytes, file_name: str):
        document = self.build_document_from_bytes(file_bytes, file_name)
        self.page_count = len(document.pages)
        renderer = self.resolve_dependencies(self.renderer)
        return renderer(document)


@contextmanager
def open_in_memory_pdf_path(file_name: str, file_bytes: bytes):
    fd, strategy = create_anonymous_pdf_fd(file_name)
    try:
        remaining = memoryview(file_bytes)
        while remaining:
            written = os.write(fd, remaining)
            remaining = remaining[written:]
        file_path = resolve_fd_path(fd)
        LOGGER.debug("Using anonymous PDF path strategy=%s path=%s", strategy, file_path)
        yield file_path
    finally:
        os.close(fd)


def convert_file_bytes(file_bytes: bytes, file_name: str) -> ConvertResponse:
    started_at = time.perf_counter()
    file_size_bytes = len(file_bytes)
    LOGGER.info("Starting conversion: file=%s size_bytes=%d", file_name, file_size_bytes)
    reset_torch_cuda_peak_memory()
    try:
        config_parser = ConfigParser(build_config())
        converter = InMemoryPdfConverter(
            config=config_parser.generate_config_dict(),
            artifact_dict=APP_STATE["models"],
            processor_list=config_parser.get_processors(),
            renderer=config_parser.get_renderer(),
            llm_service=config_parser.get_llm_service(),
        )
        rendered = converter.convert_bytes(file_bytes, file_name)
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
