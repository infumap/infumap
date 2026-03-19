from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import logging
import os
import platform
import re
import tempfile
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError

from backend_api import (
    BackendConfig,
    DetectedObject,
    DocumentCandidateInfo,
    ImageInfo,
    ImageTagResponse,
    ImageTaggingBackend,
    OCRRegion,
)

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
TAG_SEMAPHORE: asyncio.Semaphore | None = None

SUPPORTED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
}
DEFAULT_BACKEND_SPEC = "qwen35"
DEFAULT_QWEN_MODEL_ID = "Qwen/Qwen3.5-9B"
DEFAULT_QWEN_27B_MODEL_ID = "Qwen/Qwen3.5-27B"
DEFAULT_QWEN_35B_MODEL_ID = "Qwen/Qwen3.5-35B-A3B"
DEFAULT_FLORENCE_MODEL_ID = "microsoft/Florence-2-large-ft"
DOCUMENT_CANDIDATE_HEURISTIC_VERSION = "ocr-density-v1"
QWEN_DOCUMENT_CANDIDATE_VERSION = "qwen35-model-judged-v1"
QWEN_PROMPT_VERSION = "qwen35-search-json-v2"
QWEN_BACKEND_SPECS = {"qwen35", "qwen35-35b"}
QWEN_VISIBLE_TEXT_MAX_CHARS = 320
QWEN_IMAGE_TAG_PROMPT = """
Analyze this image for local search indexing.

Return exactly one JSON object with these keys:
- "detailed_caption": string
- "search_tags": array of strings
- "key_objects": array of strings
- "visible_text": string
- "scene": string or null
- "location_type": string or null
- "activities": array of strings
- "is_document_candidate": boolean
- "document_confidence": number from 0.0 to 1.0
- "document_reasons": array of strings

Rules:
- Be literal and visually grounded. Do not guess names, exact places, or events unless strongly supported by the image.
- "detailed_caption" should be 2 to 4 sentences and mention the setting, salient objects, and relationships that help search later.
- "search_tags" should contain 10 to 24 short lower-case tags useful for search. Include venue, scene, activity, and object cues when visible.
- "key_objects" should contain concrete visible nouns only, up to 12 entries.
- "visible_text" should contain only a short excerpt of the most useful readable text, not a full transcription. Prefer titles, names, totals, dates, IDs, ticket numbers, QR-adjacent instructions, or a few anchor phrases. Keep it under 320 characters. Use an empty string if nothing readable is visible.
- "scene" should summarize the overall setting in a short phrase.
- "location_type" should capture the venue or image type when visible, for example amusement park, beach, museum, kitchen, classroom, office, concert, wedding, receipt, queue ticket, boarding pass, bank slip, slide, screenshot, poster, menu, form, or letter.
- "activities" should contain short lower-case activity phrases.
- "is_document_candidate" should be true if the image seems intended to preserve, share, or later read the contents of a document or text-bearing artifact, even when photographed in context or held in a hand. This includes pages, forms, letters, receipts, queue tickets, passes, cards, labels, menus, posters, signs, notices, slides, screenshots, and similar artifacts that should likely go through OCR/document extraction later.
- Prefer true when the central subject is a paper, screen, sign, ticket, or other text-bearing artifact whose contents matter more than the surrounding scene.
- "document_reasons" should briefly justify the document decision in 1 to 4 short phrases.
- Keep the JSON compact and end immediately after the final closing brace.
- Output strict JSON only. No markdown fences. No extra commentary.
""".strip()
QWEN_IMAGE_TAG_RETRY_PROMPT = (
    QWEN_IMAGE_TAG_PROMPT
    + "\nRetry mode:\n"
    + '- Be extra concise while keeping the same JSON schema.\n'
    + '- Keep "detailed_caption" to 2 short sentences.\n'
    + '- Keep "search_tags" to 8 to 16 items.\n'
    + '- Keep "visible_text" to the most important excerpt only, under 160 characters.\n'
    + '- Keep "document_reasons" to 1 to 3 short phrases.\n'
)


class ImageRejectedError(Exception):
    pass


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


def backend_spec() -> str:
    raw = os.environ.get("IMAGE_TAGGING_BACKEND", "").strip()
    return raw or DEFAULT_BACKEND_SPEC


def build_runtime_summary() -> list[str]:
    summary = [
        f"python={platform.python_version()}",
        f"platform={platform.platform()}",
        f"transformers={package_version('transformers')}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"pillow={package_version('Pillow')}",
        f"backend={backend_spec()}",
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
    if raw:
        return raw

    selected_backend = backend_spec()
    if selected_backend == "qwen35-35b":
        return DEFAULT_QWEN_35B_MODEL_ID
    if selected_backend in QWEN_BACKEND_SPECS:
        return DEFAULT_QWEN_MODEL_ID
    if selected_backend == "florence":
        return DEFAULT_FLORENCE_MODEL_ID
    return DEFAULT_QWEN_MODEL_ID


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


def select_torch_dtype(device: str, backend_name: str) -> Any:
    import torch

    if device.startswith("cuda"):
        if backend_name in QWEN_BACKEND_SPECS:
            return torch.bfloat16
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


def resolve_qwen_device_map(device: str) -> str | dict[str, str]:
    requested = os.environ.get("IMAGE_TAGGING_QWEN_DEVICE_MAP", "").strip().lower()
    if requested == "auto":
        return "auto"

    if device == "cuda":
        return {"": "cuda:0"}
    if device.startswith("cuda:"):
        return {"": device}
    return device


def resolve_qwen_conditional_generation_class(model_id: str) -> type[Any]:
    from transformers import AutoConfig

    pretrained_config = AutoConfig.from_pretrained(model_id)
    model_type = getattr(pretrained_config, "model_type", "")

    candidates_by_type = {
        "qwen3_5": [
            ("transformers", "Qwen3_5ForConditionalGeneration"),
            ("transformers.models.qwen3_5", "Qwen3_5ForConditionalGeneration"),
            ("transformers.models.qwen3_5.modeling_qwen3_5", "Qwen3_5ForConditionalGeneration"),
        ],
        "qwen3_5_moe": [
            ("transformers", "Qwen3_5MoeForConditionalGeneration"),
            ("transformers.models.qwen3_5_moe", "Qwen3_5MoeForConditionalGeneration"),
            ("transformers.models.qwen3_5_moe.modeling_qwen3_5_moe", "Qwen3_5MoeForConditionalGeneration"),
        ],
    }
    candidate_symbols = candidates_by_type.get(model_type)
    if candidate_symbols is None:
        raise ImportError(
            f"Unsupported Qwen model_type={model_type!r} for model {model_id!r}. "
            "Expected 'qwen3_5' or 'qwen3_5_moe'."
        )

    errors: list[str] = []
    for module_name, symbol_name in candidate_symbols:
        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            errors.append(f"{module_name}: {exc}")
            continue

        resolved = getattr(module, symbol_name, None)
        if resolved is not None:
            return resolved
        errors.append(f"{module_name}: missing {symbol_name}")

    transformers_version = package_version("transformers")
    raise ImportError(
        "Could not find the expected Qwen 3.5 conditional-generation class in transformers "
        f"{transformers_version} for model_type={model_type}. Tried: {'; '.join(errors)}. "
        "If this machine has an older or incomplete transformers build, rerun with "
        "IMAGE_TAGGING_TRANSFORMERS_VERSION=5.3.0 or newer."
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    global TAG_SEMAPHORE

    max_concurrency = env_int("IMAGE_TAGGING_MAX_CONCURRENCY", 1)
    TAG_SEMAPHORE = asyncio.Semaphore(max_concurrency)
    LOGGER.info("Image tagging startup: %s", " ".join(build_runtime_summary()))

    device = select_device()
    selected_backend = backend_spec()
    dtype = select_torch_dtype(device, selected_backend)
    config = BackendConfig(
        backend_spec=selected_backend,
        model_id=model_id(),
        device=device,
        dtype=dtype,
        max_concurrency=max_concurrency,
    )
    backend = load_backend(config)
    backend.startup()
    APP_STATE["backend"] = backend

    try:
        yield
    finally:
        if "backend" in APP_STATE:
            try:
                APP_STATE["backend"].shutdown()
            finally:
                APP_STATE.clear()
        TAG_SEMAPHORE = None


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


def prepare_inputs(prompt: str, image: Image.Image, processor: Any, device: str, dtype: Any) -> Any:
    encoded = processor(text=prompt, images=image, return_tensors="pt")
    return {
        "input_ids": encoded["input_ids"].to(device),
        "pixel_values": encoded["pixel_values"].to(device=device, dtype=dtype),
    }


def run_task(
    task_prompt: str,
    image: Image.Image,
    max_new_tokens: int,
    processor: Any,
    model: Any,
    device: str,
    dtype: Any,
) -> tuple[Any, int]:
    started_at = time.perf_counter()
    import torch

    with torch.inference_mode():
        inputs = prepare_inputs(task_prompt, image, processor, device, dtype)
        generated_ids = model.generate(
            input_ids=inputs["input_ids"],
            pixel_values=inputs["pixel_values"],
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=3,
        )

    generated_text = processor.batch_decode(generated_ids, skip_special_tokens=False)[0]
    parsed_answer = processor.post_process_generation(
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


def collapse_whitespace(value: str) -> str:
    return " ".join(value.split())


def coerce_optional_string(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    normalized = collapse_whitespace(value.strip())
    return normalized or None


def coerce_string_list(value: Any, limit: int | None = None) -> list[str]:
    raw_items: list[str] = []
    if isinstance(value, str):
        raw_items = re.split(r"[\n,;]+", value)
    elif isinstance(value, list):
        for item in value:
            raw_items.extend(re.split(r"[\n,;]+", item if isinstance(item, str) else str(item)))
    elif value is not None:
        raw_items = [str(value)]

    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        cleaned = collapse_whitespace(item.strip())
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        normalized.append(cleaned)
        if limit is not None and len(normalized) >= limit:
            break
    return normalized


def coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def trim_excerpt_text(value: str, max_chars: int) -> str:
    normalized = collapse_whitespace(value.strip())
    if len(normalized) <= max_chars:
        return normalized

    clipped = normalized[: max_chars - 3].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0]
    return f"{clipped}..."


def strip_qwen_reasoning(text: str) -> str:
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()


def apply_chat_template_with_fallback(processor: Any, messages: list[dict[str, Any]]) -> str:
    try:
        return processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
    except TypeError:
        return processor.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )


def extract_first_json_object(text: str) -> dict[str, Any]:
    cleaned = strip_qwen_reasoning(text).strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
        cleaned = cleaned.strip()

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = cleaned.find("{")
    if start < 0:
        raise ValueError("Model output did not contain a JSON object.")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(cleaned)):
        char = cleaned[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue

        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                parsed = json.loads(cleaned[start : index + 1])
                if not isinstance(parsed, dict):
                    raise ValueError("Model output JSON root was not an object.")
                return parsed

    raise ValueError("Model output contained an incomplete JSON object.")


DOCUMENT_ARTIFACT_KEYWORDS = (
    "ticket",
    "queue ticket",
    "receipt",
    "bank slip",
    "slip",
    "invoice",
    "bill",
    "statement",
    "form",
    "letter",
    "document",
    "page",
    "printout",
    "note",
    "card",
    "pass",
    "badge",
    "label",
    "menu",
    "poster",
    "sign",
    "notice",
    "flyer",
    "brochure",
    "pamphlet",
    "slide",
    "screenshot",
    "qr code",
)


def qwen_document_keyword_hits(parsed: dict[str, Any]) -> list[str]:
    candidate_text = " ".join(
        part.lower()
        for part in [
            coerce_optional_string(parsed.get("location_type")) or "",
            coerce_optional_string(parsed.get("scene")) or "",
            coerce_optional_string(parsed.get("detailed_caption")) or "",
            *coerce_string_list(parsed.get("document_reasons"), limit=8),
        ]
        if part
    )

    hits: list[str] = []
    for keyword in DOCUMENT_ARTIFACT_KEYWORDS:
        if keyword in candidate_text and keyword not in hits:
            hits.append(keyword)
    return hits


def build_qwen_document_candidate_info(parsed: dict[str, Any], visible_text: str) -> DocumentCandidateInfo:
    document_reasons = coerce_string_list(parsed.get("document_reasons"), limit=8)
    document_confidence = max(0.0, min(coerce_float(parsed.get("document_confidence"), 0.0), 1.0))
    visible_text_word_count = len(visible_text.split())
    visible_text_char_count = len(visible_text)
    model_flag = bool(parsed.get("is_document_candidate"))
    keyword_hits = qwen_document_keyword_hits(parsed)

    triggered_rules = [f"model:{reason.lower()}" for reason in document_reasons]
    triggered_rules.extend(f"keyword:{keyword}" for keyword in keyword_hits[:4])
    if document_confidence >= 0.65:
        triggered_rules.append("document_confidence>=0.65")
    if visible_text_word_count >= 10:
        triggered_rules.append("visible_text_word_count>=10")
    if visible_text_char_count >= 60:
        triggered_rules.append("visible_text_char_count>=60")

    is_document_candidate = model_flag or document_confidence >= 0.65 or bool(keyword_hits)
    return DocumentCandidateInfo(
        heuristic_version=QWEN_DOCUMENT_CANDIDATE_VERSION,
        is_document_candidate=is_document_candidate,
        triggered_rules=triggered_rules,
        text_region_count=0,
        text_char_count=visible_text_char_count,
        text_word_count=visible_text_word_count,
        text_coverage_ratio=0.0,
    )


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


class Qwen35Backend(ImageTaggingBackend):
    def __init__(self, config: BackendConfig):
        super().__init__(config)
        self.processor: Any | None = None
        self.model: Any | None = None

    @property
    def name(self) -> str:
        if self.config.backend_spec in QWEN_BACKEND_SPECS:
            return self.config.backend_spec
        return "qwen35"

    def startup(self) -> None:
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig

        if not self.config.device.startswith("cuda"):
            raise RuntimeError("The built-in Qwen image-tagging backend requires a CUDA GPU.")

        total_memory_gib = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
        if total_memory_gib < 24:
            raise RuntimeError(
                f"The built-in Qwen backend expects roughly 24 GiB+ of GPU memory; found {total_memory_gib:.1f} GiB."
            )

        started_at = time.perf_counter()
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
        model_class = resolve_qwen_conditional_generation_class(self.config.model_id)
        device_map = resolve_qwen_device_map(self.config.device)
        try:
            self.processor = AutoProcessor.from_pretrained(self.config.model_id)
            self.model = model_class.from_pretrained(
                self.config.model_id,
                device_map=device_map,
                torch_dtype=torch.bfloat16,
                quantization_config=quantization_config,
            )
        except torch.OutOfMemoryError as exc:
            if self.config.model_id == DEFAULT_QWEN_35B_MODEL_ID:
                raise RuntimeError(
                    f"{DEFAULT_QWEN_35B_MODEL_ID} did not fit in GPU memory on this machine, even with 4-bit quantization. "
                    f"For a 32 GiB GPU, prefer IMAGE_TAGGING_BACKEND=qwen35 or IMAGE_TAGGING_MODEL_ID={DEFAULT_QWEN_MODEL_ID}."
                ) from exc
            if self.config.model_id == DEFAULT_QWEN_27B_MODEL_ID:
                raise RuntimeError(
                    f"{DEFAULT_QWEN_27B_MODEL_ID} did not fit in GPU memory on this machine in the native Transformers backend. "
                    f"For a 32 GiB GPU here, prefer IMAGE_TAGGING_MODEL_ID={DEFAULT_QWEN_MODEL_ID}."
                ) from exc
            raise RuntimeError(
                f"{self.config.model_id} ran out of GPU memory during startup. "
                "Try a smaller model or use a GPU with more VRAM."
            ) from exc
        except OSError as exc:
            if self.config.model_id == "Qwen/Qwen3.5-35B-A3B-Instruct":
                raise RuntimeError(
                    "The model id 'Qwen/Qwen3.5-35B-A3B-Instruct' does not exist on Hugging Face. "
                    f"Use '{DEFAULT_QWEN_35B_MODEL_ID}' instead."
                ) from exc
            raise
        self.model.eval()
        load_duration_ms = int((time.perf_counter() - started_at) * 1000)
        LOGGER.info(
            "Qwen backend loaded in %d ms: model_id=%s device=%s dtype=%s quantization=4bit-nf4 model_class=%s device_map=%s",
            load_duration_ms,
            self.config.model_id,
            self.config.device,
            torch_dtype_name(self.config.dtype),
            model_class.__name__,
            device_map,
        )

    def shutdown(self) -> None:
        self.model = None
        self.processor = None
        clear_torch_cache()

    def health_ready(self) -> bool:
        return self.model is not None and self.processor is not None

    def _generate_analysis_json(self, image: Image.Image, file_name: str) -> tuple[dict[str, Any], str, int, int]:
        if self.model is None or self.processor is None:
            raise RuntimeError("Qwen backend is not initialized.")

        tokenizer = getattr(self.processor, "tokenizer", None)
        eos_token_id = getattr(tokenizer, "eos_token_id", None)
        pad_token_id = getattr(tokenizer, "pad_token_id", None) or eos_token_id
        attempt_specs = [
            {"max_new_tokens": 1024, "do_sample": False, "prompt_text": QWEN_IMAGE_TAG_PROMPT},
            {"max_new_tokens": 1536, "do_sample": False, "prompt_text": QWEN_IMAGE_TAG_RETRY_PROMPT},
        ]

        generation_started_at = time.perf_counter()
        last_error: Exception | None = None
        for attempt_index, attempt_spec in enumerate(attempt_specs, start=1):
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "image": image},
                        {"type": "text", "text": attempt_spec["prompt_text"]},
                    ],
                }
            ]

            prompt = apply_chat_template_with_fallback(self.processor, messages)
            inputs = self.processor(
                text=[prompt],
                images=[image],
                padding=True,
                return_tensors="pt",
            )
            model_input_device = next(self.model.parameters()).device
            inputs = inputs.to(model_input_device)
            generated_ids = self.model.generate(
                **inputs,
                max_new_tokens=attempt_spec["max_new_tokens"],
                do_sample=attempt_spec["do_sample"],
                eos_token_id=eos_token_id,
                pad_token_id=pad_token_id,
            )
            generated_ids_trimmed = [
                output_ids[len(input_ids) :] for input_ids, output_ids in zip(inputs.input_ids, generated_ids)
            ]
            raw_output_text = self.processor.batch_decode(
                generated_ids_trimmed,
                skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )[0]

            try:
                parsed = extract_first_json_object(raw_output_text)
                analysis_duration_ms = int((time.perf_counter() - generation_started_at) * 1000)
                return parsed, raw_output_text, analysis_duration_ms, attempt_index
            except ValueError as exc:
                last_error = exc
                cleaned_output = strip_qwen_reasoning(raw_output_text)
                LOGGER.warning(
                    "Qwen JSON parse failed: file=%s attempt=%d/%d error=%s output_chars=%d output_tail=%r",
                    file_name,
                    attempt_index,
                    len(attempt_specs),
                    exc,
                    len(cleaned_output),
                    cleaned_output[-240:],
                )

        if last_error is None:
            last_error = RuntimeError("Qwen generation did not produce any output.")
        raise ValueError(
            f"{last_error} after {len(attempt_specs)} generation attempts."
        ) from last_error

    def tag_image_file(self, file_path: str, file_name: str, upload_mime_type: str | None) -> ImageTagResponse:
        if self.model is None or self.processor is None:
            raise RuntimeError("Qwen backend is not initialized.")

        started_at = time.perf_counter()
        file_size_bytes = Path(file_path).stat().st_size
        LOGGER.info("Starting image tagging: file=%s size_bytes=%d backend=%s", file_name, file_size_bytes, self.name)

        image, detected_mime_type = prepare_image(file_path)
        mime_type = upload_mime_type or detected_mime_type
        if mime_type is not None and mime_type not in SUPPORTED_MIME_TYPES:
            raise ImageRejectedError(f"Unsupported image MIME type: {mime_type}")

        try:
            parsed, raw_output_text, analysis_duration_ms, analysis_attempts = self._generate_analysis_json(
                image=image,
                file_name=file_name,
            )
            detailed_caption = coerce_optional_string(parsed.get("detailed_caption"))
            search_tags = normalize_object_labels(coerce_string_list(parsed.get("search_tags"), limit=24))
            key_objects = normalize_object_labels(coerce_string_list(parsed.get("key_objects"), limit=12))
            visible_text = trim_excerpt_text(
                coerce_optional_string(parsed.get("visible_text")) or "",
                max_chars=QWEN_VISIBLE_TEXT_MAX_CHARS,
            )
            scene = coerce_optional_string(parsed.get("scene"))
            location_type = coerce_optional_string(parsed.get("location_type"))
            activities = normalize_object_labels(coerce_string_list(parsed.get("activities"), limit=12))

            merged_tags = normalize_object_labels(search_tags + key_objects + activities)
            if scene:
                merged_tags = normalize_object_labels(merged_tags + [scene])
            if location_type:
                merged_tags = normalize_object_labels(merged_tags + [location_type])

            objects = [DetectedObject(label=label, bbox=[]) for label in key_objects]
            document_candidate = build_qwen_document_candidate_info(parsed, visible_text)

            duration_ms = int((time.perf_counter() - started_at) * 1000)
            cuda_memory = torch_cuda_memory_summary()
            LOGGER.info(
                "Completed image tagging: file=%s size_bytes=%d duration_ms=%d width=%d height=%d tags=%d backend=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                image.width,
                image.height,
                len(merged_tags),
                self.name,
                f" {cuda_memory}" if cuda_memory else "",
            )

            return ImageTagResponse(
                success=True,
                file_name=file_name,
                backend=self.name,
                model_id=self.config.model_id,
                image=ImageInfo(width=image.width, height=image.height, mime_type=mime_type),
                detailed_caption=detailed_caption,
                tags=merged_tags,
                objects=objects,
                ocr_text=visible_text,
                ocr_regions=[],
                document_candidate=document_candidate,
                raw_task_outputs={
                    "analysis_prompt": QWEN_IMAGE_TAG_PROMPT,
                    "model_output_text": strip_qwen_reasoning(raw_output_text),
                    "parsed_json": parsed,
                },
                task_durations_ms={
                    "analysis": analysis_duration_ms,
                },
                backend_payload={
                    "prompt_version": QWEN_PROMPT_VERSION,
                    "analysis_attempts": analysis_attempts,
                    "scene": scene,
                    "location_type": location_type,
                    "activities": activities,
                    "document_confidence": max(0.0, min(coerce_float(parsed.get("document_confidence"), 0.0), 1.0)),
                    "document_reasons": coerce_string_list(parsed.get("document_reasons"), limit=8),
                },
                duration_ms=duration_ms,
            )
        except Exception:
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            cuda_memory = torch_cuda_memory_summary()
            LOGGER.exception(
                "Image tagging failed: file=%s size_bytes=%d duration_ms=%d backend=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                self.name,
                f" {cuda_memory}" if cuda_memory else "",
            )
            raise
        finally:
            image.close()
            clear_torch_cache()


class FlorenceBackend(ImageTaggingBackend):
    def __init__(self, config: BackendConfig):
        super().__init__(config)
        self.processor: Any | None = None
        self.model: Any | None = None

    @property
    def name(self) -> str:
        return "florence"

    def startup(self) -> None:
        from transformers import AutoModelForCausalLM, AutoProcessor

        started_at = time.perf_counter()
        self.processor = AutoProcessor.from_pretrained(self.config.model_id, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            self.config.model_id,
            torch_dtype=self.config.dtype,
            trust_remote_code=True,
        ).to(self.config.device)
        self.model.eval()
        load_duration_ms = int((time.perf_counter() - started_at) * 1000)
        LOGGER.info(
            "Florence backend loaded in %d ms: model_id=%s device=%s dtype=%s",
            load_duration_ms,
            self.config.model_id,
            self.config.device,
            torch_dtype_name(self.config.dtype),
        )

    def shutdown(self) -> None:
        self.model = None
        self.processor = None
        clear_torch_cache()

    def health_ready(self) -> bool:
        return self.model is not None and self.processor is not None

    def tag_image_file(self, file_path: str, file_name: str, upload_mime_type: str | None) -> ImageTagResponse:
        if self.model is None or self.processor is None:
            raise RuntimeError("Florence backend is not initialized.")

        started_at = time.perf_counter()
        file_size_bytes = Path(file_path).stat().st_size
        LOGGER.info("Starting image tagging: file=%s size_bytes=%d backend=%s", file_name, file_size_bytes, self.name)

        image, detected_mime_type = prepare_image(file_path)
        mime_type = upload_mime_type or detected_mime_type
        if mime_type is not None and mime_type not in SUPPORTED_MIME_TYPES:
            raise ImageRejectedError(f"Unsupported image MIME type: {mime_type}")

        try:
            detailed_caption_result, detailed_caption_duration_ms = run_task(
                "<DETAILED_CAPTION>",
                image,
                max_new_tokens=256,
                processor=self.processor,
                model=self.model,
                device=self.config.device,
                dtype=self.config.dtype,
            )
            object_detection_result, object_detection_duration_ms = run_task(
                "<OD>",
                image,
                max_new_tokens=1024,
                processor=self.processor,
                model=self.model,
                device=self.config.device,
                dtype=self.config.dtype,
            )
            ocr_result, ocr_duration_ms = run_task(
                "<OCR_WITH_REGION>",
                image,
                max_new_tokens=1024,
                processor=self.processor,
                model=self.model,
                device=self.config.device,
                dtype=self.config.dtype,
            )

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
                "Completed image tagging: file=%s size_bytes=%d duration_ms=%d width=%d height=%d objects=%d ocr_regions=%d backend=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                image.width,
                image.height,
                len(objects),
                len(ocr_regions),
                self.name,
                f" {cuda_memory}" if cuda_memory else "",
            )

            return ImageTagResponse(
                success=True,
                file_name=file_name,
                backend=self.name,
                model_id=self.config.model_id,
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
                backend_payload={},
                duration_ms=duration_ms,
            )
        except Exception:
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            cuda_memory = torch_cuda_memory_summary()
            LOGGER.exception(
                "Image tagging failed: file=%s size_bytes=%d duration_ms=%d backend=%s%s",
                file_name,
                file_size_bytes,
                duration_ms,
                self.name,
                f" {cuda_memory}" if cuda_memory else "",
            )
            raise
        finally:
            image.close()
            clear_torch_cache()


def _load_custom_backend_module(spec: str):
    if spec.startswith("module:"):
        return importlib.import_module(spec[len("module:") :])

    if spec.startswith("file:"):
        path = Path(spec[len("file:") :]).expanduser()
        if not path.is_absolute():
            path = (Path(__file__).resolve().parent / path).resolve()
        module_spec = importlib.util.spec_from_file_location(f"image_tagging_backend_{path.stem}", path)
        if module_spec is None or module_spec.loader is None:
            raise ImportError(f"Could not load image tagging backend module from '{path}'.")
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module

    raise ValueError(
        "Unsupported IMAGE_TAGGING_BACKEND value. Use 'qwen35-35b', 'qwen35', 'florence', 'module:<python.import.path>', or 'file:<path.py>'."
    )


def load_backend(config: BackendConfig) -> ImageTaggingBackend:
    if config.backend_spec in QWEN_BACKEND_SPECS:
        return Qwen35Backend(config)
    if config.backend_spec == "florence":
        return FlorenceBackend(config)

    module = _load_custom_backend_module(config.backend_spec)
    if hasattr(module, "load_backend"):
        backend = module.load_backend(config)
    elif hasattr(module, "Backend"):
        backend = module.Backend(config)
    else:
        raise ImportError(
            f"Image tagging backend '{config.backend_spec}' must expose load_backend(config) or Backend(config)."
        )

    required_methods = ["startup", "shutdown", "tag_image_file", "health_ready"]
    for method_name in required_methods:
        if not hasattr(backend, method_name):
            raise TypeError(
                f"Image tagging backend '{config.backend_spec}' is missing required method '{method_name}'."
            )
    if not hasattr(backend, "name"):
        raise TypeError(f"Image tagging backend '{config.backend_spec}' is missing required property 'name'.")
    return backend


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "infumap-image-tagging",
        "docs": "/docs",
        "health": "/healthz",
    }


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    backend = APP_STATE.get("backend")
    return {
        "ok": backend is not None and backend.health_ready(),
        "backend": getattr(backend, "name", None),
        "model_id": getattr(getattr(backend, "config", None), "model_id", None),
    }


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
        backend = APP_STATE.get("backend")
        if backend is None or not backend.health_ready():
            raise HTTPException(status_code=503, detail="Image tagging backend is not ready.")
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
            return await asyncio.to_thread(backend.tag_image_file, temp_path, file_name, content_type)
    except ImageRejectedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        Path(temp_path).unlink(missing_ok=True)
        await file.close()
