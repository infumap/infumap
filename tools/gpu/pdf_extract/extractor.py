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
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from docling_backend import DoclingBackend
from marker_backend import MarkerBackend
from extraction_errors import (
    BackendUnavailableError,
    DoclingConversionError,
    DocumentRejectedError,
    ExtractionTimeoutError,
    PDF_EXTRACTION_FAILED_ERROR_CODE,
    classify_document_rejection,
    is_resource_failure,
)

LOGGER = logging.getLogger("uvicorn.error")
# Reported with every extraction. Bump it when routing or Markdown export
# changes, so extracted text can be traced to the logic that produced it.
SERVICE_VERSION = "0.2.0"
# Share of the conversion deadline Docling may use, leaving Marker time to run.
DOCLING_TIME_BUDGET_FRACTION = 0.5
# Docling's reported version fields, by package name.
DOCLING_VERSION_FIELDS = {
    "docling": "docling_version",
    "docling-core": "docling_core_version",
    "docling-parse": "docling_parse_version",
    "docling-ibm-models": "docling_ibm_models_version",
}


def package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "unknown"


def extraction_info(
    backend: str,
    versions: dict[str, str],
    *,
    fallback_reason: str | None = None,
    assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Describe how the returned Markdown was produced.

    This block's shape is stable for Infumap, unlike the other diagnostics.
    Page lists describe the returned Markdown, so they are empty for Marker.
    """
    return {
        "backend": backend,
        "backend_versions": versions,
        "service_version": SERVICE_VERSION,
        "fallback_reason": fallback_reason,
        "unusable_pages": list((assessment or {}).get("unusable_pages") or []),
        "warning_pages": list((assessment or {}).get("warning_pages") or []),
    }


class PdfExtractor:
    """Use native extraction unless the document is mostly scanned or garbled.

    A Docling failure on the document falls back to Marker. If Marker also
    fails on it, the document is rejected as pdf_extraction_failed rather than
    retried. BackendUnavailableError is reserved for problems with the service
    itself, which the caller retries.
    """

    def __init__(self) -> None:
        self.marker = MarkerBackend()
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
                file_bytes, file_name, timeout_secs=remaining * DOCLING_TIME_BUDGET_FRACTION
            )
            assessment = result.get("assessment")
            if not isinstance(assessment, dict) or "fallback_reason" not in assessment:
                raise DoclingConversionError("Docling worker returned no coverage assessment.")
            if assessment["fallback_reason"] is None and not isinstance(result.get("markdown"), str):
                raise DoclingConversionError("Accepted Docling result contains no Markdown.")
        except DoclingConversionError as exc:
            reason = f"docling_conversion_failed: {exc}"
            diagnostics = {"error": str(exc)}
            LOGGER.warning("Docling failed; falling back to Marker: file=%s reason=%s", file_name, exc)
        else:
            reason = assessment["fallback_reason"]
            diagnostics = {
                "version": result.get("version"),
                "status": result.get("status"),
                "errors": result.get("errors", []),
                "confidence": result.get("confidence"),
                "assessment": assessment,
            }
            if reason is None:
                LOGGER.info(
                    "Selected PDF backend: file=%s backend=docling pages=%s unusable_pages=%s warning_pages=%s",
                    file_name,
                    result["page_count"],
                    assessment.get("unusable_pages"),
                    assessment.get("warning_pages"),
                )
                reported = result.get("version") or {}
                versions = {
                    package: str(reported.get(field) or "unknown")
                    for package, field in DOCLING_VERSION_FIELDS.items()
                }
                return result["markdown"], {
                    "backend": "docling",
                    "page_count": result["page_count"],
                    "docling": diagnostics,
                    "extraction": extraction_info("docling", versions, assessment=assessment),
                }

        if time.monotonic() >= deadline:
            raise ExtractionTimeoutError("PDF conversion deadline expired before Marker fallback.")
        LOGGER.info("Selected PDF backend: file=%s backend=marker fallback_reason=%s", file_name, reason)
        try:
            markdown, metadata = self.marker.convert(file_bytes, file_name)
        except Exception as exc:
            description = f"Marker {type(exc).__name__}: {exc}"
            if is_resource_failure(description):
                raise BackendUnavailableError(description) from exc
            if classify_document_rejection(exc) is not None:
                raise
            raise DocumentRejectedError(
                PDF_EXTRACTION_FAILED_ERROR_CODE,
                f"Neither Docling nor Marker could extract this PDF ({reason}; {description}).",
            ) from exc
        return markdown, {
            **metadata,
            "backend": "marker",
            "fallback_reason": reason,
            "docling": diagnostics,
            "extraction": extraction_info(
                "marker", {"marker-pdf": package_version("marker-pdf")}, fallback_reason=reason
            ),
        }

    def close(self) -> None:
        self.docling.cancel()
        self.marker.close()
