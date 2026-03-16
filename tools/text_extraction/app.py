from __future__ import annotations

import logging
import os
import platform
import tempfile
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("infumap.text_extraction")


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


def build_runtime_summary() -> list[str]:
    summary = [
        f"python={platform.python_version()}",
        f"platform={platform.platform()}",
        f"marker={package_version('marker-pdf')}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"torch_device_env={os.environ.get('TORCH_DEVICE', '<unset>')}",
        f"cuda_visible_devices={os.environ.get('CUDA_VISIBLE_DEVICES', '<unset>')}",
        f"use_llm={'yes' if os.environ.get('GOOGLE_API_KEY') else 'no'}",
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


@asynccontextmanager
async def lifespan(_: FastAPI):
    config = build_config()
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
        "pdftext_workers": 1,
    }


def metadata_to_dict(metadata: Any) -> dict[str, Any]:
    if metadata is None:
        return {}
    if hasattr(metadata, "model_dump"):
        value = metadata.model_dump()
        return value if isinstance(value, dict) else {"value": value}
    if isinstance(metadata, dict):
        return metadata
    return {"value": metadata}


def convert_file(file_path: str, file_name: str) -> ConvertResponse:
    started_at = time.perf_counter()
    config_parser = ConfigParser(build_config())
    converter = PdfConverter(
        config=config_parser.generate_config_dict(),
        artifact_dict=APP_STATE["models"],
        processor_list=config_parser.get_processors(),
        renderer=config_parser.get_renderer(),
        llm_service=config_parser.get_llm_service(),
    )
    rendered = converter(file_path)
    markdown, _, _ = text_from_rendered(rendered)
    duration_ms = int((time.perf_counter() - started_at) * 1000)

    return ConvertResponse(
        success=True,
        file_name=file_name,
        markdown=markdown,
        metadata=metadata_to_dict(rendered.metadata),
        duration_ms=duration_ms,
    )


def store_upload(upload: UploadFile) -> str:
    suffix = "".join(Path(upload.filename or "").suffixes) or ".bin"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
        return handle.name


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
async def convert_upload(file: UploadFile = File(...)) -> ConvertResponse:
    temp_path = store_upload(file)
    file_name = Path(file.filename or "upload").name

    try:
        return convert_file(temp_path, file_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        Path(temp_path).unlink(missing_ok=True)
        await file.close()
