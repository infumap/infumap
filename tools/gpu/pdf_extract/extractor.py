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
from marker_backend import MarkerBackend
from extraction_errors import BackendUnavailableError, DoclingConversionError, ExtractionTimeoutError

LOGGER = logging.getLogger("uvicorn.error")


class PdfExtractor:
    """Use native extraction only when every page passes the coverage gate."""

    def __init__(self) -> None:
        self.marker = MarkerBackend()
        self.docling = DoclingBackend()

    def load(self) -> None:
        self.docling.check_ready()

    def convert(
        self, file_bytes: bytes, file_name: str, *, deadline: float
    ) -> tuple[str, dict[str, Any]]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ExtractionTimeoutError("PDF conversion deadline expired.")
        try:
            result = self.docling.convert(file_bytes, file_name, timeout_secs=remaining)
        except DoclingConversionError as exc:
            reason = f"docling_conversion_failed: {exc}"
            diagnostics = {"error": str(exc)}
        else:
            assessment = result.get("assessment")
            if not isinstance(assessment, dict) or "fallback_reason" not in assessment:
                raise BackendUnavailableError("Docling worker returned no coverage assessment.")
            reason = assessment["fallback_reason"]
            diagnostics = {
                "version": result.get("version"),
                "status": result.get("status"),
                "errors": result.get("errors", []),
                "confidence": result.get("confidence"),
                "assessment": assessment,
            }
            if reason is None:
                markdown = result.get("markdown")
                if not isinstance(markdown, str):
                    raise BackendUnavailableError("Accepted Docling result contains no Markdown.")
                if time.monotonic() >= deadline:
                    raise ExtractionTimeoutError("PDF conversion deadline expired.")
                LOGGER.info("Selected PDF backend: file=%s backend=docling pages=%s", file_name, result["page_count"])
                return markdown, {
                    "backend": "docling",
                    "page_count": result["page_count"],
                    "docling": diagnostics,
                }

        if time.monotonic() >= deadline:
            raise ExtractionTimeoutError("PDF conversion deadline expired before Marker fallback.")
        LOGGER.info("Selected PDF backend: file=%s backend=marker fallback_reason=%s", file_name, reason)
        markdown, metadata = self.marker.convert(file_bytes, file_name)
        if time.monotonic() >= deadline:
            raise ExtractionTimeoutError("PDF conversion deadline expired during Marker fallback.")
        return markdown, {**metadata, "backend": "marker", "fallback_reason": reason, "docling": diagnostics}

    def close(self) -> None:
        self.docling.cancel()
        self.marker.close()
