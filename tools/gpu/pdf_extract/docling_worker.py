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

import json
import logging
import sys
from io import BytesIO
from pathlib import Path

from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.pipeline_options import (
    HeadingHierarchyOptions,
    PdfPipelineOptions,
    TableFormerMode,
    TableStructureOptions,
)
from docling.document_converter import DocumentConverter, PdfFormatOption
import pypdfium2 as pdfium

from docling_quality import assess_and_render
from extraction_errors import (
    BackendUnavailableError,
    DocumentRejectedError,
    classify_document_rejection,
    is_setup_failure,
)


def build_converter() -> DocumentConverter:
    options = PdfPipelineOptions()
    options.do_ocr = False
    options.do_table_structure = True
    # Explicitly select TableFormer V1, as used by Groundwork's pinned version.
    options.table_structure_options = TableStructureOptions(
        mode=TableFormerMode.ACCURATE, do_cell_matching=True
    )
    options.generate_parsed_pages = True
    options.heading_hierarchy_options = HeadingHierarchyOptions(enabled=True)
    options.do_code_enrichment = False
    options.do_formula_enrichment = False
    options.do_picture_classification = False
    options.do_picture_description = False
    options.do_chart_extraction = False
    options.generate_page_images = False
    options.generate_picture_images = False
    options.generate_table_images = False
    return DocumentConverter(
        allowed_formats=[InputFormat.PDF],
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
        },
    )


def convert(source_path: str, filename: str) -> dict:
    source = DocumentStream(name=filename, stream=BytesIO(Path(source_path).read_bytes()))
    result = build_converter().convert(source, raises_on_error=False)
    # Other reported errors leave a non-success status, which the assessment
    # turns into a Marker fallback.
    for error in result.errors:
        message = error.error_message
        rejection = classify_document_rejection(RuntimeError(message))
        if rejection is not None:
            raise DocumentRejectedError(*rejection)
        if is_setup_failure(message):
            raise BackendUnavailableError(message)

    pdf = pdfium.PdfDocument(source_path)
    try:
        assessment, markdown = assess_and_render(result, pdf)
    finally:
        pdf.close()
    # Only what the service uses. JSON serialization normalizes non-finite
    # confidence values.
    payload = json.loads(result.model_dump_json(include={"version", "status", "errors", "confidence"}))
    payload["page_count"] = result.input.page_count
    payload["assessment"] = assessment
    payload["markdown"] = markdown
    return payload


def main() -> None:
    source_path, output_path, filename = sys.argv[1:]
    try:
        payload = convert(source_path, filename)
    except Exception as exc:
        logging.exception("Docling worker failed for %s", filename)
        rejection = classify_document_rejection(exc)
        message = f"Docling {type(exc).__name__}: {exc}"
        if isinstance(exc, DocumentRejectedError):
            error = {"kind": "document", "error_code": exc.error_code, "message": exc.message}
        elif rejection is not None:
            error = {"kind": "document", "error_code": rejection[0], "message": rejection[1]}
        elif isinstance(exc, (BackendUnavailableError, ImportError)) or is_setup_failure(message):
            # Marker would hide a broken installation, and the caller retries.
            error = {"kind": "unavailable", "message": message}
        else:
            # Includes memory exhaustion: this document may be too much for
            # Docling but not for Marker, and retrying it would not help.
            error = {"kind": "conversion", "message": message}
        payload = {"worker_error": error}
    Path(output_path).write_text(json.dumps(payload, ensure_ascii=False, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    main()
