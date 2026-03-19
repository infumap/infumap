from __future__ import annotations

import asyncio
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
from pydantic import BaseModel, Field
from PIL import Image, ImageOps, UnidentifiedImageError

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
TAG_SEMAPHORE: asyncio.Semaphore | None = None

SUPPORTED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
}
DEFAULT_MODEL_ID = "microsoft/Florence-2-large-ft"
DOCUMENT_CANDIDATE_HEURISTIC_VERSION = "ocr-density-v1"


class ImageRejectedError(Exception):
    pass


class ImageInfo(BaseModel):
    width: int
    height: int
    mime_type: str | None


class DetectedObject(BaseModel):
    label: str
    bbox: list[float] = Field(default_factory=list)


class OCRRegion(BaseModel):
    text: str
    quad_box: list[float] = Field(default_factory=list)


class DocumentCandidateInfo(BaseModel):
    heuristic_version: str
    is_document_candidate: bool
    triggered_rules: list[str]
    text_region_count: int
    text_char_count: int
    text_word_count: int
    text_coverage_ratio: float


class ImageTagResponse(BaseModel):
    success: bool
    file_name: str
    model_id: str
    image: ImageInfo
    detailed_caption: str | None
    tags: list[str]
    objects: list[DetectedObject]
    ocr_text: str
    ocr_regions: list[OCRRegion]
    document_candidate: DocumentCandidateInfo
    raw_task_outputs: dict[str, Any]
    task_durations_ms: dict[str, int]
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
        f"transformers={package_version('transformers')}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"pillow={package_version('Pillow')}",
        f"model_id={model_id()}",
        f"torch_device_env={os.environ.get('TORCH_DEVICE', '<unset>')}",
        f"cuda_visible_devices={os.environ.get('CUDA_VISIBLE_DEVICES', '<unset>')}",
        f"max_concurrency={env_int('IMAGE_TAGGING_MAX_CONCURRENCY', 1)}",
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


def model_id() -> str:
    raw = os.environ.get("IMAGE_TAGGING_MODEL_ID", "").strip()
    return raw or DEFAULT_MODEL_ID


def select_device() -> str:
    import torch

    requested = os.environ.get("TORCH_DEVICE", "").strip()
    if requested:
        normalized = requested.lower()
        if normalized.startswith("cuda"):
            if torch.cuda.is_available():
                return requested
            LOGGER.warning("TORCH_DEVICE=%s requested, but CUDA is unavailable. Falling back.", requested)
        elif normalized == "mps":
            if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
                return requested
            LOGGER.warning("TORCH_DEVICE=%s requested, but MPS is unavailable. Falling back.", requested)
        elif normalized == "cpu":
            return "cpu"
        else:
            LOGGER.warning("Unsupported TORCH_DEVICE=%s. Falling back.", requested)

    if torch.cuda.is_available():
        return "cuda:0"
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def select_torch_dtype(device: str) -> Any:
    import torch

    if device.startswith("cuda"):
        return torch.float16
    return torch.float32


def torch_dtype_name(dtype: Any) -> str:
    return str(dtype).replace("torch.", "")


def clear_torch_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
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
    global TAG_SEMAPHORE

    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor

    TAG_SEMAPHORE = asyncio.Semaphore(env_int("IMAGE_TAGGING_MAX_CONCURRENCY", 1))
    LOGGER.info("Image tagging startup: %s", " ".join(build_runtime_summary()))

    device = select_device()
    dtype = select_torch_dtype(device)
    started_at = time.perf_counter()
    processor = AutoProcessor.from_pretrained(model_id(), trust_remote_code=True, use_fast=False)
    model = AutoModelForCausalLM.from_pretrained(
        model_id(),
        torch_dtype=dtype,
        trust_remote_code=True,
    ).to(device)
    model.eval()
    load_duration_ms = int((time.perf_counter() - started_at) * 1000)

    APP_STATE["device"] = device
    APP_STATE["dtype"] = dtype
    APP_STATE["model"] = model
    APP_STATE["processor"] = processor
    APP_STATE["model_id"] = model_id()

    LOGGER.info(
        "Florence model loaded in %d ms: model_id=%s device=%s dtype=%s",
        load_duration_ms,
        model_id(),
        device,
        torch_dtype_name(dtype),
    )
    yield
    APP_STATE.clear()
    TAG_SEMAPHORE = None
    clear_torch_cache()


app = FastAPI(
    title="Infumap Image Tagging Service",
    version="0.1.0",
    lifespan=lifespan,
)


def store_upload(upload: UploadFile) -> tuple[str, int]:
    suffix = "".join(Path(upload.filename or "").suffixes) or ".bin"
    total_bytes = 0
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            total_bytes += len(chunk)
            handle.write(chunk)
        return handle.name, total_bytes


def prepare_image(file_path: str) -> tuple[Image.Image, str | None]:
    try:
        with Image.open(file_path) as opened:
            image_format = opened.format
            image = ImageOps.exif_transpose(opened)
            if getattr(image, "is_animated", False):
                raise ImageRejectedError("Animated images are not supported.")
            image.load()
            if image.mode != "RGB":
                image = image.convert("RGB")
            mime_type = Image.MIME.get(image_format) if image_format else None
            return image, mime_type
    except ImageRejectedError:
        raise
    except UnidentifiedImageError as exc:
        raise ImageRejectedError("The uploaded file is not a supported raster image.") from exc


def prepare_inputs(prompt: str, image: Image.Image) -> Any:
    encoded = APP_STATE["processor"](text=prompt, images=image, return_tensors="pt")
    device = APP_STATE["device"]
    dtype = APP_STATE["dtype"]
    return {
        "input_ids": encoded["input_ids"].to(device),
        "pixel_values": encoded["pixel_values"].to(device=device, dtype=dtype),
    }


def run_task(task_prompt: str, image: Image.Image, max_new_tokens: int) -> tuple[Any, int]:
    started_at = time.perf_counter()
    import torch

    with torch.inference_mode():
        inputs = prepare_inputs(task_prompt, image)
        generated_ids = APP_STATE["model"].generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=3,
        )

    generated_text = APP_STATE["processor"].batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed_answer = APP_STATE["processor"].post_process_generation(
        generated_text,
        task=task_prompt,
        image_size=(image.width, image.height),
    )
    duration_ms = int((time.perf_counter() - started_at) * 1000)
    return parsed_answer, duration_ms


def normalize_object_labels(labels: list[str]) -> list[str]:
    seen: set[str] = set()
    tags: list[str] = []
    for label in labels:
        normalized = " ".join(label.strip().lower().split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        tags.append(normalized)
    return tags


def quad_box_coverage_ratio(quad_boxes: list[list[float]], image_area: float) -> float:
    if image_area <= 0:
        return 0.0
    covered_area = 0.0
    for quad_box in quad_boxes:
        if len(quad_box) != 8:
            continue
        xs = quad_box[0::2]
        ys = quad_box[1::2]
        width = max(xs) - min(xs)
        height = max(ys) - min(ys)
        if width > 0 and height > 0:
            covered_area += width * height
    return min(covered_area / image_area, 1.0)


def build_document_candidate_info(labels: list[str], quad_boxes: list[list[float]], image: Image.Image) -> DocumentCandidateInfo:
    text_labels = [label.strip() for label in labels if label.strip()]
    text_region_count = len(text_labels)
    text_char_count = sum(len(label) for label in text_labels)
    text_word_count = sum(len(label.split()) for label in text_labels)
    coverage_ratio = quad_box_coverage_ratio(quad_boxes, float(image.width * image.height))

    triggered_rules: list[str] = []
    if text_region_count >= 8:
        triggered_rules.append("text_region_count>=8")
    if text_char_count >= 120:
        triggered_rules.append("text_char_count>=120")
    if text_word_count >= 24:
        triggered_rules.append("text_word_count>=24")
    if coverage_ratio >= 0.18:
        triggered_rules.append("text_coverage_ratio>=0.18")

    is_document_candidate = coverage_ratio >= 0.25 or len(triggered_rules) >= 2
    return DocumentCandidateInfo(
        heuristic_version=DOCUMENT_CANDIDATE_HEURISTIC_VERSION,
        is_document_candidate=is_document_candidate,
        triggered_rules=triggered_rules,
        text_region_count=text_region_count,
        text_char_count=text_char_count,
        text_word_count=text_word_count,
        text_coverage_ratio=round(coverage_ratio, 4),
    )


def tag_image_file(file_path: str, file_name: str, upload_mime_type: str | None) -> ImageTagResponse:
    started_at = time.perf_counter()
    file_size_bytes = Path(file_path).stat().st_size
    LOGGER.info("Starting image tagging: file=%s size_bytes=%d", file_name, file_size_bytes)

    image, detected_mime_type = prepare_image(file_path)
    mime_type = upload_mime_type or detected_mime_type
    if mime_type is not None and mime_type not in SUPPORTED_MIME_TYPES:
        raise ImageRejectedError(f"Unsupported image MIME type: {mime_type}")

    try:
        detailed_caption_result, detailed_caption_duration_ms = run_task("<DETAILED_CAPTION>", image, max_new_tokens=256)
        object_detection_result, object_detection_duration_ms = run_task("<OD>", image, max_new_tokens=1024)
        ocr_result, ocr_duration_ms = run_task("<OCR_WITH_REGION>", image, max_new_tokens=1024)

        detailed_caption = detailed_caption_result.get("<DETAILED_CAPTION>")
        od_payload = object_detection_result.get("<OD>", {})
        ocr_payload = ocr_result.get("<OCR_WITH_REGION>", {})

        od_labels = od_payload.get("labels", []) if isinstance(od_payload, dict) else []
        od_boxes = od_payload.get("bboxes", []) if isinstance(od_payload, dict) else []
        ocr_labels = ocr_payload.get("labels", []) if isinstance(ocr_payload, dict) else []
        ocr_quad_boxes = ocr_payload.get("quad_boxes", []) if isinstance(ocr_payload, dict) else []

        objects = [
            DetectedObject(label=str(label), bbox=[float(v) for v in bbox])
            for label, bbox in zip(od_labels, od_boxes)
        ]
        ocr_regions = [
            OCRRegion(text=str(label), quad_box=[float(v) for v in quad_box])
            for label, quad_box in zip(ocr_labels, ocr_quad_boxes)
            if str(label).strip()
        ]
        tags = normalize_object_labels([obj.label for obj in objects])
        ocr_text = "\n".join(region.text for region in ocr_regions)
        document_candidate = build_document_candidate_info(
            [region.text for region in ocr_regions],
            [region.quad_box for region in ocr_regions],
            image,
        )

        duration_ms = int((time.perf_counter() - started_at) * 1000)
        cuda_memory = torch_cuda_memory_summary()
        LOGGER.info(
            "Completed image tagging: file=%s size_bytes=%d duration_ms=%d width=%d height=%d objects=%d ocr_regions=%d%s",
            file_name,
            file_size_bytes,
            duration_ms,
            image.width,
            image.height,
            len(objects),
            len(ocr_regions),
            f" {cuda_memory}" if cuda_memory else "",
        )

        return ImageTagResponse(
            success=True,
            file_name=file_name,
            model_id=APP_STATE["model_id"],
            image=ImageInfo(width=image.width, height=image.height, mime_type=mime_type),
            detailed_caption=detailed_caption if isinstance(detailed_caption, str) else None,
            tags=tags,
            objects=objects,
            ocr_text=ocr_text,
            ocr_regions=ocr_regions,
            document_candidate=document_candidate,
            raw_task_outputs={
                "<DETAILED_CAPTION>": detailed_caption_result.get("<DETAILED_CAPTION>"),
                "<OD>": od_payload,
                "<OCR_WITH_REGION>": ocr_payload,
            },
            task_durations_ms={
                "detailed_caption": detailed_caption_duration_ms,
                "object_detection": object_detection_duration_ms,
                "ocr_with_region": ocr_duration_ms,
            },
            duration_ms=duration_ms,
        )
    except Exception:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        cuda_memory = torch_cuda_memory_summary()
        LOGGER.exception(
            "Image tagging failed: file=%s size_bytes=%d duration_ms=%d%s",
            file_name,
            file_size_bytes,
            duration_ms,
            f" {cuda_memory}" if cuda_memory else "",
        )
        raise
    finally:
        image.close()
        clear_torch_cache()


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "infumap-image-tagging",
        "docs": "/docs",
        "health": "/healthz",
    }


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": "model" in APP_STATE and "processor" in APP_STATE}


@app.post("/tag", response_model=ImageTagResponse)
async def tag_upload(file: UploadFile = File(...)) -> ImageTagResponse:
    file_name = Path(file.filename or "upload").name
    content_type = (file.content_type or "").strip().lower() or None
    request_started_at = time.perf_counter()
    LOGGER.info(
        "Received image tagging request: file=%s content_type=%s",
        file_name,
        content_type or "<unset>",
    )
    upload_started_at = time.perf_counter()
    temp_path, upload_size_bytes = store_upload(file)
    upload_duration_ms = int((time.perf_counter() - upload_started_at) * 1000)
    LOGGER.info(
        "Stored image tagging upload: file=%s size_bytes=%d upload_ms=%d",
        file_name,
        upload_size_bytes,
        upload_duration_ms,
    )

    try:
        semaphore = TAG_SEMAPHORE
        if semaphore is None:
            raise HTTPException(status_code=503, detail="Image tagging service is not ready.")
        semaphore_wait_started_at = time.perf_counter()
        if semaphore.locked():
            LOGGER.info(
                "Image tagging request waiting for worker slot: file=%s size_bytes=%d",
                file_name,
                upload_size_bytes,
            )
        async with semaphore:
            semaphore_wait_ms = int((time.perf_counter() - semaphore_wait_started_at) * 1000)
            request_age_ms = int((time.perf_counter() - request_started_at) * 1000)
            LOGGER.info(
                "Dispatching image tagging run: file=%s size_bytes=%d request_age_ms=%d semaphore_wait_ms=%d",
                file_name,
                upload_size_bytes,
                request_age_ms,
                semaphore_wait_ms,
            )
            return await asyncio.to_thread(tag_image_file, temp_path, file_name, content_type)
    except ImageRejectedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        Path(temp_path).unlink(missing_ok=True)
        await file.close()
