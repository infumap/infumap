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
import time
from typing import Any

from docling_backend import DoclingBackend
from extraction_errors import (
    BackendUnavailableError,
    DoclingConversionError,
    DocumentRejectedError,
    ExtractionTimeoutError,
    PDF_EXTRACTION_FAILED_ERROR_CODE,
    is_resource_failure,
)

LOGGER = logging.getLogger("uvicorn.error")
# Reported with every extraction. Bump it when routing, Markdown export or a
# pinned extraction package changes, so extracted text can be traced to the
# code that produced it.
SERVICE_VERSION = "0.4.0"
# Share of the conversion deadline native extraction may use, leaving OCR time
# to run.
NATIVE_TIME_BUDGET_FRACTION = 0.5
# Docling conversion statuses whose OCR output is used.
USABLE_OCR_STATUSES = {"success", "partial_success"}


def extraction_info(
    backend: str,
    *,
    fallback_reason: str | None = None,
    assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Describe how the returned Markdown was produced.

    This block's shape is stable for Infumap, unlike the other diagnostics.
    backend is "docling" or "docling_ocr"; service_version identifies the
    OCR engine. Page lists describe native extraction, so they are empty for
    OCR, and fallback_reason says why OCR was used.
    """
    return {
        "backend": backend,
        "service_version": SERVICE_VERSION,
        "fallback_reason": fallback_reason,
        "unusable_pages": list((assessment or {}).get("unusable_pages") or []),
        "warning_pages": list((assessment or {}).get("warning_pages") or []),
    }


def conversion_diagnostics(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": result.get("version"),
        "status": result.get("status"),
        "errors": result.get("errors", []),
        "confidence": result.get("confidence"),
    }


class PdfExtractor:
    """Use native extraction unless the document is mostly scanned or garbled.

    Otherwise, or when native extraction fails on the document, OCR every page
    with Docling. If OCR also fails on it, the document is rejected as
    pdf_extraction_failed. BackendUnavailableError is reserved for problems
    with the service itself, which the caller retries.
    """

    def __init__(self) -> None:
        self.docling = DoclingBackend()

    def load(self) -> None:
        self.docling.load()

    def convert(
        self, file_bytes: bytes, file_name: str, *, deadline: float
    ) -> tuple[str, dict[str, Any]]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExtractionTimeoutError("PDF conversion deadline expired.")
        try:
            result = self.docling.convert(
                file_bytes, file_name, timeout_secs=remaining * NATIVE_TIME_BUDGET_FRACTION
            )
            assessment = result.get("assessment")
            if not isinstance(assessment, dict) or "fallback_reason" not in assessment:
                raise DoclingConversionError("Docling worker returned no coverage assessment.")
            if assessment["fallback_reason"] is None and not isinstance(result.get("markdown"), str):
                raise DoclingConversionError("Accepted Docling result contains no Markdown.")
        except DoclingConversionError as exc:
            reason = f"docling_conversion_failed: {exc}"
            native = {"error": str(exc)}
            LOGGER.warning("Native extraction failed; falling back to OCR: file=%s reason=%s", file_name, exc)
        else:
            reason = assessment["fallback_reason"]
            native = {**conversion_diagnostics(result), "assessment": assessment}
            if reason is None:
                LOGGER.info(
                    "Selected PDF extraction: file=%s method=native pages=%s unusable_pages=%s warning_pages=%s",
                    file_name,
                    result["page_count"],
                    assessment.get("unusable_pages"),
                    assessment.get("warning_pages"),
                )
                return result["markdown"], {
                    "backend": "docling",
                    "page_count": result["page_count"],
                    "docling": native,
                    "extraction": extraction_info("docling", assessment=assessment),
                }

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExtractionTimeoutError("PDF conversion deadline expired before OCR fallback.")
        LOGGER.info("Selected PDF extraction: file=%s method=ocr fallback_reason=%s", file_name, reason)
        try:
            result = self.docling.convert(file_bytes, file_name, timeout_secs=remaining, ocr=True)
            if not isinstance(result.get("markdown"), str):
                raise DoclingConversionError("Docling OCR result contains no Markdown.")
            if result.get("status") not in USABLE_OCR_STATUSES:
                raise DoclingConversionError(f"Docling OCR conversion status was {result.get('status')!r}.")
        except DoclingConversionError as exc:
            if time.monotonic() >= deadline:
                raise ExtractionTimeoutError("PDF conversion deadline expired during OCR.") from exc
            if is_resource_failure(str(exc)):
                raise BackendUnavailableError(f"Docling OCR: {exc}") from exc
            raise DocumentRejectedError(
                PDF_EXTRACTION_FAILED_ERROR_CODE,
                f"Neither native extraction nor OCR could extract this PDF ({reason}; Docling OCR: {exc}).",
            ) from exc
        ocr = result.get("ocr") or {}
        LOGGER.info(
            "OCR completed: file=%s pages=%s status=%s engine=%s lang=%s device=%s",
            file_name,
            result.get("page_count"),
            result.get("status"),
            ocr.get("engine"),
            ocr.get("lang"),
            ocr.get("device"),
        )
        return result["markdown"], {
            "backend": "docling_ocr",
            "page_count": result.get("page_count"),
            "fallback_reason": reason,
            "docling": native,
            "ocr": {**conversion_diagnostics(result), **ocr},
            "extraction": extraction_info("docling_ocr", fallback_reason=reason),
        }

    def close(self) -> None:
        self.docling.cancel()
