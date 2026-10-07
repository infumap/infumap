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

import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

# Set before Marker/Surya imports, including when used outside the HTTP wrapper.
if not os.environ.get("SURYA_GUIDED_LAYOUT", "").strip():
    os.environ["SURYA_GUIDED_LAYOUT"] = "0"

from marker.config.parser import ConfigParser
from marker.converters.pdf import PdfConverter
from marker.models import create_model_dict
from marker.output import text_from_rendered

from extraction_errors import PDF_INFERENCE_FAILED_ERROR_CODE, DocumentRejectedError

LOGGER = logging.getLogger("uvicorn.error")
PDFTEXT_WORKERS = 1
VALID_CONVERSION_MODES = ("balanced", "fast")


def conversion_mode() -> str:
    raw = os.environ.get("TEXT_EXTRACTION_MODE", "").strip().lower()
    if not raw:
        return "balanced"
    if raw not in VALID_CONVERSION_MODES:
        raise ValueError(
            f"Invalid TEXT_EXTRACTION_MODE={raw!r}; expected 'balanced' or 'fast'."
        )
    return raw


def build_config() -> dict[str, Any]:
    return {
        "force_ocr": False,
        "paginate_output": True,
        "use_llm": bool(os.environ.get("GOOGLE_API_KEY")),
        "output_format": "markdown",
        "pdftext_workers": PDFTEXT_WORKERS,
        "mode": conversion_mode(),
    }


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


def metadata_to_dict(metadata: Any) -> dict[str, Any]:
    if metadata is None:
        return {}
    if hasattr(metadata, "model_dump"):
        value = metadata.model_dump()
        return value if isinstance(value, dict) else {"value": value}
    if isinstance(metadata, dict):
        return metadata
    return {"value": metadata}


class InferenceFailureCounter:
    """Counts surya VLM requests that still failed after surya's own retries.

    Marker does not fail a conversion when these requests fail: it leaves the
    affected page layout, OCR block or table empty and returns the rest. Every
    VLM request (layout, OCR and table OCR) goes through the one inference
    manager, so counting its results catches them all.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests = 0
        self.failures = 0

    def wrap(self, manager: Any) -> None:
        generate = manager.generate

        def counted_generate(batch: Any) -> Any:
            outputs = generate(batch)
            failures = sum(1 for output in outputs if getattr(output, "error", False))
            with self._lock:
                self.requests += len(outputs)
                self.failures += failures
            return outputs

        manager.generate = counted_generate

    def reset(self) -> None:
        with self._lock:
            self.requests = 0
            self.failures = 0

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return self.requests, self.failures


class MarkerBackend:
    """Marker conversion and model ownership, independent of HTTP handling."""

    def __init__(self) -> None:
        self.config = build_config()
        self.models: dict[str, Any] | None = None
        self.inference_failures = InferenceFailureCounter()

    def load(self) -> None:
        if self.models is not None:
            return
        LOGGER.info("Marker extraction config: %s", self.config)
        started_at = time.perf_counter()
        models = create_model_dict()
        manager = models.get("inference_manager")
        if manager is None or not callable(getattr(manager, "generate", None)):
            # Without it, failed inference would silently produce empty pages.
            raise RuntimeError("Marker models have no inference_manager; cannot detect failed inference requests.")
        self.inference_failures.wrap(manager)
        self.models = models
        LOGGER.info(
            "Marker models loaded in %d ms: %s",
            int((time.perf_counter() - started_at) * 1000),
            summarize_loaded_models(self.models),
        )

    def convert(self, file_bytes: bytes, file_name: str) -> tuple[str, dict[str, Any]]:
        self.load()
        # Marker needs a path; keep its temporary files inside this backend.
        suffix = "".join(Path(file_name or "upload").suffixes) or ".bin"
        with tempfile.TemporaryDirectory(prefix="infumap-marker-") as directory:
            path = Path(directory) / ("document" + suffix)
            path.write_bytes(file_bytes)
            config_parser = ConfigParser(self.config)
            converter = PdfConverter(
                config=config_parser.generate_config_dict(),
                artifact_dict=self.models,
                processor_list=config_parser.get_processors(),
                renderer=config_parser.get_renderer(),
                llm_service=config_parser.get_llm_service(),
            )
            self.inference_failures.reset()
            rendered = converter(str(path))
            requests, failures = self.inference_failures.snapshot()
            if failures:
                raise DocumentRejectedError(
                    PDF_INFERENCE_FAILED_ERROR_CODE,
                    f"Marker's inference server failed {failures} of {requests} request(s) after retries, "
                    "so pages, text blocks or tables would be missing; see 'Inference error' in the PDF "
                    "extraction service log.",
                )
            markdown, _, _ = text_from_rendered(rendered)
            return markdown, metadata_to_dict(rendered.metadata)

    def close(self) -> None:
        self.models = None
