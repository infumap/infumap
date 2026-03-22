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
import base64
import io
import json
import logging
import os
import platform
import re
import time
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from PIL import Image, ImageOps, UnidentifiedImageError
from python_multipart import MultipartParser
from python_multipart.multipart import parse_options_header

from backend_api import ImageTagResponse

APP_STATE: dict[str, Any] = {}
LOGGER = logging.getLogger("uvicorn.error")
TAG_SEMAPHORE: asyncio.Semaphore | None = None

SUPPORTED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/tiff",
}
FORMAT_MIME_OVERRIDES = {
    "MPO": "image/jpeg",
}
FORMATS_REJECTED_WHEN_MULTIFRAME = {
    "PNG",
    "WEBP",
}
VISIBLE_TEXT_MAX_CHARS = 320
LLAMA_BACKEND_NAME = "llama-server"
LLAMA_IMAGE_SLOT_ID = 1
DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024
DEFAULT_TARGET_MAX_PIXELS = 3_145_728
DEFAULT_TARGET_MAX_LONG_EDGE = 2048
DEFAULT_OUTPUT_JPEG_QUALITY = 90
DEFAULT_MAX_TOKENS = 8192
GPU_REQUEST_CONCURRENCY = 1

SYSTEM_PROMPT = """
You analyze images for search indexing.

Return strict JSON only. Do not use markdown. Do not explain the JSON. Do not include any text before or after the JSON object.
""".strip()

IMAGE_TAG_PROMPT = """
Analyze this image for local search indexing.

Return exactly one JSON object with these keys:
- "detailed_caption": string
- "scene": string or null
- "document_confidence": number from 0.0 to 1.0
- "face_recognition_candidate_confidence": number from 0.0 to 1.0
- "visible_face_count_estimate": string
- "tags": array of strings
- "ocr_text": array of strings

Rules:
- Be literal and visually grounded. Do not guess names, exact places, or events unless strongly supported by the image.
- If uncertain, prefer null, an empty array or "0" rather than guessing.
- "detailed_caption" should be 2 to 4 short sentences covering the setting, salient objects, and relationships that help search later.
- "scene" should summarize the overall setting in a short phrase.
- "document_confidence" should estimate whether the image mainly seems intended to preserve, share, or later read a document or text-bearing artifact; use high values only when the artifact itself is clearly the main subject and meant to be read or kept.
- Use around 0.5 for borderline cases where a document, screen, sign, page, or label is prominent and partly readable, but it is unclear whether reading or preserving its contents is the main purpose of the image.
- Use low values for ordinary scene photos, aesthetic compositions, desk or room setups, portraits, or environmental shots where a paper, screen, sign, laptop, or other text-bearing object is merely present or even prominent but is not obviously being captured for its readable content.
- "face_recognition_candidate_confidence" should estimate whether the image is suitable for downstream real-person face matching across photos.
- Use 1.0 for clear strong positives such as portraits, selfies, posed two-person photos, or clear group photos where at least one real human face is near-frontal, sharp, and large enough to confidently send to face matching; use 0.8 to 0.95 for usable but imperfect cases such as moderately sized faces, slight angle, mild blur, or partial occlusion.
- Use around 0.5 for borderline cases where a real face is present and may be usable, but is not clearly strong enough to confidently send to face matching.
- Use 0.0 when there is no usable real face, including no people, body-only shots, back-of-head views, tiny distant faces, heavy blur, strong occlusion, or non-human faces. Ignore faces on screens, posters, photos, paintings, toys, or statues for this score.
- "visible_face_count_estimate" should estimate how many real human faces are visibly present using exactly one of these strings: "0", "1", "2", "3-5", or "6+".
- Count only real visible human faces in the captured scene. Do not count faces on screens, posters, photos, paintings, toys, or statues.
- "tags" should contain 6 to 14 short lower-case tags useful for search. Fewer is better than adding weak tags.
- Prefer concrete visible tags. Add broader context only when clearly supported by the image.
- Prefer precise, non-repetitive tags over generic or speculative ones.
- "ocr_text" should be an array of distinct useful readable snippets, not a full transcription. Keep one snippet or sign per entry, do not merge unrelated text, keep the combined total under 320 characters, and use an empty array if nothing readable is visible.
""".strip()

class ImageRejectedError(Exception):
    pass


class LlamaServerError(Exception):
    def __init__(self, status_code: int | None, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


class ImageTooLargeError(Exception):
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
        return int(raw)
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


def env_str(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None:
        return default
    normalized = raw.strip()
    return normalized or default


def llama_server_url() -> str:
    configured = os.environ.get("IMAGE_TAGGING_LLAMA_SERVER_URL", "").strip()
    if configured:
        return configured.rstrip("/")
    host = env_str("IMAGE_TAGGING_LLAMA_HOST", "127.0.0.1")
    port = env_int("IMAGE_TAGGING_LLAMA_PORT", 18080)
    return f"http://{host}:{port}"


def llama_model_file() -> str:
    configured = os.environ.get("IMAGE_TAGGING_MODEL_FILE", "").strip()
    if configured:
        return configured
    configured = os.environ.get("IMAGE_TAGGING_MODEL_ID", "").strip()
    if configured:
        return configured
    return "local-model.gguf"


def llama_model_name() -> str:
    configured = os.environ.get("IMAGE_TAGGING_LLAMA_MODEL_NAME", "").strip()
    if configured:
        return configured
    return Path(llama_model_file()).stem or "local-model"


def llama_model_id() -> str:
    configured = os.environ.get("IMAGE_TAGGING_MODEL_ID", "").strip()
    if configured:
        return configured
    repo = os.environ.get("IMAGE_TAGGING_MODEL_REPO", "").strip()
    model_file = os.environ.get("IMAGE_TAGGING_MODEL_FILE", "").strip()
    if repo and model_file:
        return f"{repo}:{model_file}"
    if model_file:
        return model_file
    return llama_model_name()


def max_upload_bytes() -> int:
    return max(1, env_int("IMAGE_TAGGING_MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES))


def target_max_pixels() -> int:
    return max(1, env_int("IMAGE_TAGGING_TARGET_MAX_PIXELS", DEFAULT_TARGET_MAX_PIXELS))


def target_max_long_edge() -> int:
    return max(1, env_int("IMAGE_TAGGING_TARGET_MAX_LONG_EDGE", DEFAULT_TARGET_MAX_LONG_EDGE))


def output_jpeg_quality() -> int:
    return max(1, min(100, env_int("IMAGE_TAGGING_OUTPUT_JPEG_QUALITY", DEFAULT_OUTPUT_JPEG_QUALITY)))


def build_runtime_summary() -> list[str]:
    return [
        f"python={platform.python_version()}",
        f"platform={platform.platform()}",
        f"fastapi={package_version('fastapi')}",
        f"uvicorn={package_version('uvicorn')}",
        f"httpx={package_version('httpx')}",
        f"pillow={package_version('Pillow')}",
        f"backend={LLAMA_BACKEND_NAME}",
        f"llama_server_url={llama_server_url()}",
        f"model_id={llama_model_id()}",
        f"model_name={llama_model_name()}",
        f"max_concurrency={GPU_REQUEST_CONCURRENCY}",
        f"max_upload_bytes={max_upload_bytes()}",
        f"target_max_pixels={target_max_pixels()}",
        f"target_max_long_edge={target_max_long_edge()}",
        f"output_jpeg_quality={output_jpeg_quality()}",
    ]


@asynccontextmanager
async def lifespan(_: FastAPI):
    global TAG_SEMAPHORE

    timeout = httpx.Timeout(
        connect=max(5.0, env_float("IMAGE_TAGGING_LLAMA_CONNECT_TIMEOUT_SECS", 10.0)),
        read=max(30.0, env_float("IMAGE_TAGGING_LLAMA_READ_TIMEOUT_SECS", 30.0 * 60.0)),
        write=max(30.0, env_float("IMAGE_TAGGING_LLAMA_WRITE_TIMEOUT_SECS", 60.0)),
        pool=max(5.0, env_float("IMAGE_TAGGING_LLAMA_POOL_TIMEOUT_SECS", 60.0)),
    )
    APP_STATE["llama_client"] = httpx.AsyncClient(base_url=llama_server_url(), timeout=timeout)
    APP_STATE["model_name"] = llama_model_name()
    APP_STATE["model_id"] = llama_model_id()
    TAG_SEMAPHORE = asyncio.Semaphore(GPU_REQUEST_CONCURRENCY)
    LOGGER.info("Image tagging startup: %s", " ".join(build_runtime_summary()))

    try:
        yield
    finally:
        client = APP_STATE.pop("llama_client", None)
        if client is not None:
            await client.aclose()
        APP_STATE.clear()
        TAG_SEMAPHORE = None


app = FastAPI(
    title="Infumap Image Tagging Service",
    version="0.2.0",
    lifespan=lifespan,
)


def collapse_whitespace(value: str) -> str:
    return " ".join(value.split())


def image_resampling_filter() -> int:
    if hasattr(Image, "Resampling"):
        return Image.Resampling.LANCZOS
    return Image.LANCZOS


def decode_header_value(value: bytes | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        decoded = value.decode("utf-8", errors="replace")
    else:
        decoded = str(value)
    normalized = decoded.strip()
    return normalized or None


def normalized_mime_type_for_format(image_format: str | None) -> str | None:
    if not image_format:
        return None
    return FORMAT_MIME_OVERRIDES.get(image_format, Image.MIME.get(image_format))


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


def normalize_labels(labels: list[str]) -> list[str]:
    seen: set[str] = set()
    normalized: list[str] = []
    for label in labels:
        cleaned = collapse_whitespace(label.strip()).lower()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        normalized.append(cleaned)
    return normalized


def coerce_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def coerce_face_count_estimate(value: Any) -> str | None:
    if value is None:
        return None

    if isinstance(value, (int, float)):
        numeric = int(value)
        if numeric <= 0:
            return "0"
        if numeric == 1:
            return "1"
        if numeric == 2:
            return "2"
        if numeric <= 5:
            return "3-5"
        return "6+"

    normalized = collapse_whitespace(str(value).strip()).lower()
    if not normalized:
        return None

    normalized = normalized.replace("–", "-").replace("—", "-")
    normalized = normalized.replace(" to ", "-")

    if normalized in {"0", "zero", "none", "no faces", "no face", "no visible faces", "no visible face"}:
        return "0"
    if normalized in {"1", "one", "single", "one face", "1 face", "one visible face", "1 visible face"}:
        return "1"
    if normalized in {"2", "two", "two faces", "2 faces", "two visible faces", "2 visible faces"}:
        return "2"
    if normalized in {"3-5", "3 - 5", "3-4", "4", "5", "three", "four", "five", "several"}:
        return "3-5"
    if normalized in {"6+", "6", "7", "8", "9", "10+", "many", "crowd"}:
        return "6+"

    digits = re.findall(r"\d+", normalized)
    if not digits:
        return None

    numbers = [int(digit) for digit in digits]
    if "+" in normalized or max(numbers) >= 6:
        return "6+"
    if len(numbers) >= 2 and min(numbers) <= 2 and max(numbers) >= 3:
        return "3-5"

    numeric = max(numbers)
    if numeric <= 0:
        return "0"
    if numeric == 1:
        return "1"
    if numeric == 2:
        return "2"
    if numeric <= 5:
        return "3-5"
    return "6+"


def trim_excerpt_text(value: str, max_chars: int) -> str:
    normalized = collapse_whitespace(value.strip())
    if len(normalized) <= max_chars:
        return normalized
    clipped = normalized[: max_chars - 3].rstrip()
    if " " in clipped:
        clipped = clipped.rsplit(" ", 1)[0]
    return f"{clipped}..."


def normalize_visible_text(value: Any, max_chars: int) -> list[str]:
    raw_parts: list[str] = []

    if value is None:
        return []

    if isinstance(value, list):
        for item in value:
            if item is None:
                continue
            raw_parts.append(item if isinstance(item, str) else str(item))
    else:
        raw = value if isinstance(value, str) else str(value)
        raw = raw.strip()
        if not raw:
            return []
        raw_parts = [raw]

    parts: list[str] = []
    seen: set[str] = set()
    for part in raw_parts:
        cleaned = collapse_whitespace(part.strip(" ,;|"))
        if not cleaned:
            continue
        lowered = cleaned.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        parts.append(cleaned)

    limited_parts: list[str] = []
    total_chars = 0
    separator_len = 3
    for part in parts:
        addition = len(part) if not limited_parts else separator_len + len(part)
        if total_chars + addition <= max_chars:
            limited_parts.append(part)
            total_chars += addition
            continue

        if not limited_parts:
            limited_parts.append(trim_excerpt_text(part, max_chars=max_chars))
        break

    return limited_parts


def strip_reasoning(text: str) -> str:
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()


def truncate_for_log(value: str, max_chars: int = 1200) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 3] + "..."


def extract_first_json_object(text: str) -> dict[str, Any]:
    cleaned = strip_reasoning(text).strip()
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


def extract_message_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError("llama-server response did not contain any choices.")

    choice0 = choices[0]
    if not isinstance(choice0, dict):
        raise ValueError("llama-server response choice was not an object.")

    message = choice0.get("message")
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, str):
            return content

        if isinstance(content, dict):
            text = content.get("text")
            if isinstance(text, str) and text.strip():
                return text

        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                    continue
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        parts.append(text)
            joined = "".join(parts).strip()
            if joined:
                return joined

        reasoning_content = message.get("reasoning_content")
        if isinstance(reasoning_content, str) and reasoning_content.strip():
            finish_reason = choice0.get("finish_reason")
            if finish_reason == "length":
                raise ValueError(
                    "llama-server consumed its token budget in reasoning_content without returning final JSON content. "
                    "Disable reasoning, for example with --reasoning-format none."
                )

    text = choice0.get("text")
    if isinstance(text, str) and text.strip():
        return text

    raise ValueError("llama-server response message content was empty.")


def convert_image_to_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image

    has_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    if has_alpha:
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        return Image.alpha_composite(background, rgba).convert("RGB")

    return image.convert("RGB")


def resize_dimensions(width: int, height: int) -> tuple[int, int, float]:
    scale = 1.0

    longest_edge = max(width, height)
    max_long_edge = target_max_long_edge()
    if longest_edge > max_long_edge:
        scale = min(scale, max_long_edge / float(longest_edge))

    pixel_count = width * height
    max_pixels = target_max_pixels()
    if pixel_count > max_pixels:
        scale = min(scale, (max_pixels / float(pixel_count)) ** 0.5)

    if scale >= 1.0:
        return width, height, 1.0

    new_width = max(1, int(width * scale))
    new_height = max(1, int(height * scale))
    return new_width, new_height, scale


def prepare_image(upload_bytes: bytes) -> tuple[bytes, str, int, int, int, int]:
    try:
        with Image.open(io.BytesIO(upload_bytes)) as opened:
            image_format = opened.format
            detected_mime_type = normalized_mime_type_for_format(image_format)
            if detected_mime_type is None or detected_mime_type not in SUPPORTED_MIME_TYPES:
                raise ImageRejectedError("The uploaded file is not a supported raster image.")

            frame_count = max(1, int(getattr(opened, "n_frames", 1)))
            if frame_count > 1 and image_format in FORMATS_REJECTED_WHEN_MULTIFRAME:
                raise ImageRejectedError("Animated images are not supported.")

            if frame_count > 1:
                try:
                    opened.seek(0)
                except EOFError:
                    pass

            image = ImageOps.exif_transpose(opened)
            image.load()
            image = convert_image_to_rgb(image)

            original_width = image.width
            original_height = image.height
            prepared_width, prepared_height, _resize_scale = resize_dimensions(original_width, original_height)
            if prepared_width != original_width or prepared_height != original_height:
                image = image.resize((prepared_width, prepared_height), resample=image_resampling_filter())

            prepared_mime_type = "image/jpeg"
            encoded_quality = output_jpeg_quality()

            output = io.BytesIO()
            image.save(output, format="JPEG", quality=encoded_quality)
            prepared_bytes = output.getvalue()
            return (
                prepared_bytes,
                prepared_mime_type,
                original_width,
                original_height,
                prepared_width,
                prepared_height,
            )
    except ImageRejectedError:
        raise
    except (OSError, UnidentifiedImageError) as exc:
        raise ImageRejectedError("The uploaded file is not a supported raster image.") from exc


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
            raise ImageTooLargeError(
                f"Uploaded image exceeds the in-memory limit of {upload_limit} bytes. "
                "Increase IMAGE_TAGGING_MAX_UPLOAD_BYTES if needed."
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
    except ImageTooLargeError:
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


def make_data_url(mime_type: str, file_bytes: bytes) -> tuple[str, str]:
    encoded = base64.b64encode(file_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}", encoded


def build_openai_payload(data_url: str) -> dict[str, Any]:
    return {
        "model": APP_STATE.get("model_name") or llama_model_name(),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": IMAGE_TAG_PROMPT},
                ],
            },
        ],
        "response_format": {
            "type": "json_object",
        },
        "temperature": env_float("IMAGE_TAGGING_TEMPERATURE", 0.1),
        "top_p": env_float("IMAGE_TAGGING_TOP_P", 0.9),
        "max_tokens": max(256, env_int("IMAGE_TAGGING_MAX_TOKENS", DEFAULT_MAX_TOKENS)),
        "stream": False,
    }


def build_legacy_payload(image_base64: str) -> dict[str, Any]:
    return {
        "model": APP_STATE.get("model_name") or llama_model_name(),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"{IMAGE_TAG_PROMPT}\n\nImage reference: [img-{LLAMA_IMAGE_SLOT_ID}]",
            },
        ],
        "image_data": [
            {
                "id": LLAMA_IMAGE_SLOT_ID,
                "data": image_base64,
            }
        ],
        "response_format": {
            "type": "json_object",
        },
        "temperature": env_float("IMAGE_TAGGING_TEMPERATURE", 0.1),
        "top_p": env_float("IMAGE_TAGGING_TOP_P", 0.9),
        "max_tokens": max(256, env_int("IMAGE_TAGGING_MAX_TOKENS", DEFAULT_MAX_TOKENS)),
        "stream": False,
    }


async def post_chat_completion(payload: dict[str, Any]) -> dict[str, Any]:
    client = APP_STATE.get("llama_client")
    if client is None:
        raise LlamaServerError(None, "Image tagging service is not ready.")

    try:
        response = await client.post("/v1/chat/completions", json=payload)
    except httpx.HTTPError as exc:
        raise LlamaServerError(None, str(exc)) from exc

    body = response.text
    if response.is_success:
        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise LlamaServerError(response.status_code, f"Could not parse llama-server JSON response: {exc}") from exc

    raise LlamaServerError(response.status_code, body)


async def request_analysis(prepared_bytes: bytes, prepared_mime_type: str) -> tuple[dict[str, Any], str]:
    data_url, image_base64 = make_data_url(prepared_mime_type, prepared_bytes)

    request_format = "openai-image_url"
    try:
        payload = await post_chat_completion(build_openai_payload(data_url))
    except LlamaServerError as exc:
        fallback_needed = (
            exc.status_code is not None
            and exc.status_code >= 400
            and "image_url" in exc.message.lower()
            and "unsupported" in exc.message.lower()
        )
        if not fallback_needed:
            raise
        request_format = "legacy-image_data"
        payload = await post_chat_completion(build_legacy_payload(image_base64))

    try:
        message_text = extract_message_text(payload)
        parsed = extract_first_json_object(message_text)
    except ValueError as exc:
        payload_excerpt = truncate_for_log(json.dumps(payload, ensure_ascii=False))
        LOGGER.error(
            "Could not parse llama-server structured response: format=%s error=%s payload=%s",
            request_format,
            exc,
            payload_excerpt,
        )
        raise
    return parsed, request_format


async def probe_llama_server() -> tuple[bool, str | None]:
    client = APP_STATE.get("llama_client")
    if client is None:
        return False, "llama-server client not initialized"

    for path in ("/health", "/v1/models", "/"):
        try:
            response = await client.get(path)
        except httpx.HTTPError as exc:
            return False, str(exc)

        if response.status_code < 400:
            return True, None

    return False, "llama-server did not return a successful health response"


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "infumap-image-tagging",
        "backend": LLAMA_BACKEND_NAME,
        "docs": "/docs",
        "health": "/healthz",
    }


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    ok, detail = await probe_llama_server()
    return {
        "ok": ok,
        "backend": LLAMA_BACKEND_NAME,
        "model_id": APP_STATE.get("model_id"),
        "llama_server_url": llama_server_url(),
        "detail": detail,
    }


TAG_UPLOAD_OPENAPI_EXTRA = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "required": ["file"],
                    "properties": {
                        "file": {
                            "type": "string",
                            "format": "binary",
                        }
                    },
                }
            }
        },
    }
}


@app.post("/tag", response_model=ImageTagResponse, openapi_extra=TAG_UPLOAD_OPENAPI_EXTRA)
async def tag_upload(request: Request) -> ImageTagResponse:
    request_started_at = time.perf_counter()
    file_name = "upload"

    try:
        file_name, parsed_part_content_type, upload_bytes = await read_multipart_upload(request)
        content_type = (parsed_part_content_type or "").strip().lower() or None
        upload_size_bytes = len(upload_bytes)
        LOGGER.info(
            "Received in-memory image tagging upload: file=%s content_type=%s size_bytes=%d",
            file_name,
            content_type or "<unset>",
            upload_size_bytes,
        )

        prepared_bytes, prepared_mime_type, width, height, prepared_width, prepared_height = prepare_image(upload_bytes)
        if content_type is not None and content_type not in SUPPORTED_MIME_TYPES:
            raise ImageRejectedError(f"Unsupported image MIME type: {content_type}")

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
                "Dispatching llama-server run: file=%s size_bytes=%d request_age_ms=%d semaphore_wait_ms=%d",
                file_name,
                upload_size_bytes,
                request_age_ms,
                semaphore_wait_ms,
            )
            parsed, request_format = await request_analysis(
                prepared_bytes,
                prepared_mime_type,
            )

        detailed_caption = coerce_optional_string(parsed.get("detailed_caption"))
        tags = normalize_labels(coerce_string_list(parsed.get("tags"), limit=24))
        ocr_text = normalize_visible_text(parsed.get("ocr_text"), max_chars=VISIBLE_TEXT_MAX_CHARS)
        scene = coerce_optional_string(parsed.get("scene"))

        duration_ms = int((time.perf_counter() - request_started_at) * 1000)
        prepared_size_bytes = len(prepared_bytes)

        LOGGER.info(
            "Completed image tagging: file=%s upload_bytes=%d prepared_bytes=%d duration_ms=%d width=%d height=%d prepared_width=%d prepared_height=%d tags=%d backend=%s format=%s",
            file_name,
            upload_size_bytes,
            prepared_size_bytes,
            duration_ms,
            width,
            height,
            prepared_width,
            prepared_height,
            len(tags),
            LLAMA_BACKEND_NAME,
            request_format,
        )

        return ImageTagResponse(
            detailed_caption=detailed_caption,
            scene=scene,
            document_confidence=max(0.0, min(coerce_float(parsed.get("document_confidence"), 0.0), 1.0)),
            face_recognition_candidate_confidence=max(
                0.0,
                min(coerce_float(parsed.get("face_recognition_candidate_confidence"), 0.0), 1.0),
            ),
            visible_face_count_estimate=coerce_face_count_estimate(parsed.get("visible_face_count_estimate")),
            tags=tags,
            ocr_text=ocr_text,
        )
    except ImageRejectedError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ImageTooLargeError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except HTTPException:
        raise
    except (LlamaServerError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        LOGGER.exception("Image tagging failed: file=%s backend=%s", file_name, LLAMA_BACKEND_NAME)
        raise HTTPException(status_code=500, detail=str(exc)) from exc
