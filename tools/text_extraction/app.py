from __future__ import annotations

import os
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

APP_STATE: dict[str, Any] = {}


class ConvertResponse(BaseModel):
    success: bool
    file_name: str
    markdown: str
    metadata: dict[str, Any]
    duration_ms: int


@asynccontextmanager
async def lifespan(_: FastAPI):
    APP_STATE["models"] = create_model_dict()
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
