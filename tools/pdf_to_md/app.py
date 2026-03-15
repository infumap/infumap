from __future__ import annotations

import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

APP_STATE: dict[str, Any] = {}


class ConvertOptions(BaseModel):
    page_range: str | None = None
    force_ocr: bool = False
    paginate_output: bool = False
    use_llm: bool = False


class ConvertPathRequest(ConvertOptions):
    filepath: str


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
    title="Infumap Marker Service",
    version="0.1.0",
    lifespan=lifespan,
)


def build_config(options: ConvertOptions) -> dict[str, Any]:
    config = options.model_dump(exclude_none=True)
    config["output_format"] = "markdown"
    config["pdftext_workers"] = 1
    return config


def metadata_to_dict(metadata: Any) -> dict[str, Any]:
    if metadata is None:
        return {}
    if hasattr(metadata, "model_dump"):
        value = metadata.model_dump()
        return value if isinstance(value, dict) else {"value": value}
    if isinstance(metadata, dict):
        return metadata
    return {"value": metadata}


def convert_file(file_path: str, file_name: str, options: ConvertOptions) -> ConvertResponse:
    started_at = time.perf_counter()
    config_parser = ConfigParser(build_config(options))
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
        "service": "infumap-marker-service",
        "docs": "/docs",
        "health": "/healthz",
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": "models" in APP_STATE}


@app.post("/convert", response_model=ConvertResponse)
async def convert_upload(
    file: Annotated[UploadFile, File(...)],
    page_range: Annotated[str | None, Form()] = None,
    force_ocr: Annotated[bool, Form()] = False,
    paginate_output: Annotated[bool, Form()] = False,
    use_llm: Annotated[bool, Form()] = False,
) -> ConvertResponse:
    temp_path = store_upload(file)
    file_name = Path(file.filename or "upload").name

    try:
        return convert_file(
            temp_path,
            file_name,
            ConvertOptions(
                page_range=page_range,
                force_ocr=force_ocr,
                paginate_output=paginate_output,
                use_llm=use_llm,
            ),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        Path(temp_path).unlink(missing_ok=True)
        await file.close()


@app.post("/convert-path", response_model=ConvertResponse)
async def convert_path(request: ConvertPathRequest) -> ConvertResponse:
    path = Path(request.filepath).expanduser().resolve()
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        return convert_file(str(path), path.name, request)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
