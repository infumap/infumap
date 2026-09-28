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

PDF_PASSWORD_REQUIRED_ERROR_CODE = "pdf_password_required"
PDF_UNREADABLE_ERROR_CODE = "pdf_unreadable"
PDF_CONVERSION_TIMEOUT_ERROR_CODE = "pdf_conversion_timeout"


class DocumentRejectedError(Exception):
    def __init__(self, error_code: str, message: str):
        super().__init__(message)
        self.error_code = error_code
        self.message = message


class BackendUnavailableError(RuntimeError):
    """Dependency, infrastructure, or resource failure; do not try OCR."""


class DoclingConversionError(RuntimeError):
    """A document-specific Docling failure that Marker may handle."""


class ExtractionTimeoutError(TimeoutError):
    """The shared per-document conversion deadline expired."""


def classify_document_rejection(exc: Exception) -> tuple[str, str] | None:
    message = str(exc).lower()
    if "password" in message and (
        "incorrect" in message
        or "required" in message
        or "protected" in message
        or "encrypted" in message
        or "password error" in message
    ):
        return (PDF_PASSWORD_REQUIRED_ERROR_CODE, "The PDF is password protected and cannot be processed without a password.")
    if "failed to load document" in message and "data format error" in message:
        return (PDF_UNREADABLE_ERROR_CODE, "The PDF appears to be malformed or corrupted and could not be opened by PDFium.")
    return None


def is_resource_failure(message: str) -> bool:
    message = message.lower()
    return any(fragment in message for fragment in (
        "out of memory", "cannot allocate memory", "memoryerror", "not enough memory",
        "cublas_status_alloc_failed", "resource temporarily unavailable", "cuda error", "cuda driver",
        "no space left on device", "no module named", "failed to download",
        "connection refused", "connection error", "network is unreachable",
        "couldn't connect", "could not connect", "localentrynotfounderror",
        "gatedrepoerror", "401 client error", "403 client error",
    ))
